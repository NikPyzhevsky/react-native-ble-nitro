package com.margelo.nitro.co.zyke.ble

import android.app.*
import android.content.Intent
import android.os.*
import android.util.Log

class IntervalForegroundService : Service() {

    companion object {
        private const val CHANNEL_ID = "interval_channel"
        private const val NOTIF_ID = 1001

        const val ACTION_START = "com.margelo.nitro.co.zyke.ble.ACTION_START"
        const val ACTION_STOP_ALL = "com.margelo.nitro.co.zyke.ble.ACTION_STOP_ALL"

        const val EXTRA_INTERVAL_MS = "intervalMs"
        const val EXTRA_CALLBACK = "callback"

        private const val TAG = "IntervalFGService"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var intervalMs: Long = 5000
    private var callback: ResultReceiver? = null
    private var isInForeground = false

    private val tickRunnable = object : Runnable {
        override fun run() {
            callback?.send(0, Bundle().apply {
                putLong("timestamp", System.currentTimeMillis())
            })
            handler.postDelayed(this, intervalMs)
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "onCreate()")
        createNotificationChannel()
        startForeground(NOTIF_ID, buildNotification("Running…"))
        isInForeground = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand() flags=$flags startId=$startId intent=$intent")

        when (intent?.action) {
            ACTION_START, null -> {
                // Ensure we're in foreground (e.g., after process recreation)
                if (!isInForeground) {
                    startForeground(NOTIF_ID, buildNotification("Running…"))
                    isInForeground = true
                }

                // Read params
                if (intent != null) {
                    intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 5000L)
                }

                // API 33+: использовать generic getParcelableExtra
                if (intent != null) {
                    callback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(EXTRA_CALLBACK, ResultReceiver::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(EXTRA_CALLBACK)
                    }
                }

                if (callback == null) {
                    Log.w(TAG, "ResultReceiver callback is NULL — ticks will do nothing.")
                }

                // (Re)start ticker
                handler.removeCallbacks(tickRunnable)
                handler.postDelayed(tickRunnable, intervalMs)
            }

            ACTION_STOP_ALL -> {
                // Stop ticker
                handler.removeCallbacks(tickRunnable)

                // Remove foreground notification
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(Service.STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
                isInForeground = false

                // Stop service
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy()")
        handler.removeCallbacks(tickRunnable)
        if (isInForeground) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
            isInForeground = false
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        // When user swipes the notification away, we want to stop the service cleanly.
        val deletePi = PendingIntent.getService(
            this,
            0,
            Intent(this, IntervalForegroundService::class.java).apply { action = ACTION_STOP_ALL },
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT
            else
                PendingIntent.FLAG_CANCEL_CURRENT
        )

        return builder
            .setContentTitle("Device session active")
            .setContentText("Connected to your device")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setDeleteIntent(deletePi)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Сделаем IMPORTANCE_DEFAULT, чтобы точно не «потерялось» на прошивках
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Interval Worker",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }
}
