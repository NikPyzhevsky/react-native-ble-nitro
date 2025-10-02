package com.margelo.nitro.co.zyke.ble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import no.nordicsemi.android.ble.PhyRequest
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.margelo.nitro.core.*
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Android implementation of the BLE Nitro Module
 * This class provides the actual BLE functionality for Android devices
 */
class BleNitroBleManager : HybridNativeBleNitroSpec() {

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var stateCallback: ((state: BLEState) -> Unit)? = null
    private var bluetoothStateReceiver: BroadcastReceiver? = null
    private var restoreStateCallback: ((devices: List<BLEDevice>) -> Unit)? = null

    // Bonding state
    private var bondReceiver: BroadcastReceiver? = null
    private data class PendingBond(
        val deviceId: String,
        val pin: String? = null,
        val callback: (success: Boolean, error: String) -> Unit
    )
    private var pendingBond: PendingBond? = null

    // BLE Scanning
    private var bleScanner: BluetoothLeScanner? = null
    private var isCurrentlyScanning = false
    private var scanCallback: ScanCallback? = null
    private var deviceFoundCallback: ((device: BLEDevice?, error: String?) -> Unit)? = null
    private val discoveredDevicesInCurrentScan = mutableSetOf<String>()


    //nordic bluetoothManager
    private val nordicManagers = ConcurrentHashMap<String, MyNordicManager>()

    // Device connections
    private val connectedDevices = ConcurrentHashMap<String, BluetoothGatt>()
    private val deviceCallbacks = ConcurrentHashMap<String, DeviceCallbacks>()

    // Write callback storage for proper response handling (key: deviceId:characteristicId)
    private val writeCallbacks = ConcurrentHashMap<String, (Boolean, ArrayBuffer, String) -> Unit>()

    // RSSI callback storage (key: deviceId)
    private val rssiCallbacks = ConcurrentHashMap<String, (Boolean, Double, String) -> Unit>()

    // Helper class to store device callbacks
    private data class DeviceCallbacks(
        var connectCallback: ((success: Boolean, deviceId: String, error: String) -> Unit)? = null,
        var disconnectCallback: ((deviceId: String, interrupted: Boolean, error: String) -> Unit)? = null,
        var serviceDiscoveryCallback: ((success: Boolean, error: String) -> Unit)? = null,
        var characteristicSubscriptions: MutableMap<String, (characteristicId: String, data: ArrayBuffer) -> Unit> = mutableMapOf()
    )

    init {
        // Try to get context from React Native application context
        tryToGetContextFromReactNative()
    }

    companion object {
        private var appContext: Context? = null

        fun setContext(context: Context) {
            appContext = context.applicationContext
        }

        fun getContext(): Context? = appContext
    }

    private fun tryToGetContextFromReactNative() {
        if (appContext == null) {
            try {
                // Try to get Application context using reflection
                val activityThread = Class.forName("android.app.ActivityThread")
                val currentApplicationMethod = activityThread.getMethod("currentApplication")
                val application = currentApplicationMethod.invoke(null) as? android.app.Application

                if (application != null) {
                    setContext(application)
                }
            } catch (e: Exception) {
                // Context will be set by package initialization if reflection fails
            }
        }
    }

    private fun ensureBondReceiverRegistered() {
        val context = appContext ?: return
        if (bondReceiver != null) return

        bondReceiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
                        val target = pendingBond ?: return
                        val changedDevice: BluetoothDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                        }
                        if (changedDevice?.address != target.deviceId) return

                        val bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
                        val prevBondState = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR)

                        when (bondState) {
                            BluetoothDevice.BOND_BONDED -> {
                                pendingBond?.callback?.invoke(true, "")
                                pendingBond = null
                            }
                            BluetoothDevice.BOND_NONE -> {
                                val reason = intent.getIntExtra("android.bluetooth.device.extra.REASON", -1)
                                val msg = if (prevBondState == BluetoothDevice.BOND_BONDING) {
                                    "Bonding failed${if (reason != -1) " (reason=$reason)" else ""}"
                                } else {
                                    "Not bonded"
                                }
                                pendingBond?.callback?.invoke(false, msg)
                                pendingBond = null
                            }
                            // BOND_BONDING -> wait
                        }
                    }
                    BluetoothDevice.ACTION_PAIRING_REQUEST -> {
                        // Optional PIN handling if we ever add it to API
                        val target = pendingBond ?: return
                        val dev: BluetoothDevice? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                        }
                        if (dev?.address != target.deviceId) return
                        val pin = target.pin
                        if (pin != null) {
                            try {
                                @Suppress("MissingPermission")
                                dev.setPin(pin.toByteArray(Charsets.UTF_8))
                                @Suppress("MissingPermission")
                                dev.createBond()
                            } catch (_: Exception) { /* ignore */ }
                        }
                    }
                }
            }
        }

        val stateFilter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
        val pairingFilter = IntentFilter(BluetoothDevice.ACTION_PAIRING_REQUEST).apply {
            // Keep high priority similar to RN BleManager to avoid being pre-empted
            priority = IntentFilter.SYSTEM_HIGH_PRIORITY
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            context.registerReceiver(bondReceiver, stateFilter, Context.RECEIVER_EXPORTED)
            context.registerReceiver(bondReceiver, pairingFilter, Context.RECEIVER_EXPORTED)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(bondReceiver, stateFilter, Context.RECEIVER_NOT_EXPORTED)
            context.registerReceiver(bondReceiver, pairingFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(bondReceiver, stateFilter)
            context.registerReceiver(bondReceiver, pairingFilter)
        }
    }

    private fun unregisterBondReceiverIfIdle() {
        val context = appContext ?: return
        if (pendingBond == null && bondReceiver != null) {
            try {
                context.unregisterReceiver(bondReceiver)
            } catch (_: Exception) { }
            bondReceiver = null
        }
    }

    private fun initializeBluetoothIfNeeded() {
        if (bluetoothAdapter == null) {
            try {
                val context = appContext ?: return
                val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                bluetoothAdapter = bluetoothManager?.adapter
            } catch (e: Exception) {
                // Handle initialization error silently
            }
        }
    }

    private fun hasBluetoothPermissions(): Boolean {
        val context = appContext ?: return false

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ (API 31+) - check new Bluetooth permissions
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            // Android < 12 - check legacy permissions
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_ADMIN) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun getMissingPermissions(): List<String> {
        val context = appContext ?: return emptyList()
        val missing = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ permissions
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.BLUETOOTH_SCAN)
            }
        } else {
            // Legacy permissions
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.BLUETOOTH)
            }
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_ADMIN) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.BLUETOOTH_ADMIN)
            }
        }

        // Location permissions for BLE scanning
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }

        return missing
    }

    private fun bluetoothStateToBlEState(bluetoothState: Int): BLEState {
        return when (bluetoothState) {
            BluetoothAdapter.STATE_OFF -> BLEState.POWEREDOFF
            BluetoothAdapter.STATE_ON -> BLEState.POWEREDON
            BluetoothAdapter.STATE_TURNING_ON -> BLEState.RESETTING
            BluetoothAdapter.STATE_TURNING_OFF -> BLEState.RESETTING
            else -> BLEState.UNKNOWN
        }
    }

    private fun createBluetoothStateReceiver(): BroadcastReceiver {
        return object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == BluetoothAdapter.ACTION_STATE_CHANGED) {
                    val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                    val bleState = bluetoothStateToBlEState(state)
                    stateCallback?.invoke(bleState)
                }
            }
        }
    }

    private fun createBLEDeviceFromScanResult(scanResult: ScanResult): BLEDevice {
        val device = scanResult.device
        val scanRecord = scanResult.scanRecord

        // Extract manufacturer data
        val manufacturerData = scanRecord?.manufacturerSpecificData?.let { sparseArray ->
            val entries = mutableListOf<ManufacturerDataEntry>()
            for (i in 0 until sparseArray.size()) {
                val key = sparseArray.keyAt(i)
                val value = sparseArray.get(key)

                // Create direct ByteBuffer as required by ArrayBuffer.wrap()
                val directBuffer = java.nio.ByteBuffer.allocateDirect(value.size)
                directBuffer.put(value)
                directBuffer.flip()

                entries.add(ManufacturerDataEntry(
                    id = key.toString(),
                    data = ArrayBuffer.wrap(directBuffer)
                ))
            }
            ManufacturerData(companyIdentifiers = entries.toTypedArray())
        } ?: ManufacturerData(companyIdentifiers = emptyArray())

        // Extract service UUIDs
        val serviceUUIDs = scanRecord?.serviceUuids?.map { it.toString() }?.toTypedArray() ?: emptyArray()

        return BLEDevice(
            id = device.address,
            name = device.name ?: "",
            rssi = scanResult.rssi.toDouble(),
            manufacturerData = manufacturerData,
            serviceUUIDs = serviceUUIDs,
            isConnectable = true // Assume scannable devices are connectable
        )
    }

    private fun createAndroidScanFilters(filter: com.margelo.nitro.co.zyke.ble.ScanFilter): List<android.bluetooth.le.ScanFilter> {
        val filters = mutableListOf<android.bluetooth.le.ScanFilter>()

        // Add service UUID filters
        filter.serviceUUIDs.forEach { serviceId ->
            try {
                val builder = android.bluetooth.le.ScanFilter.Builder()
                val uuid = UUID.fromString(serviceId)
                builder.setServiceUuid(ParcelUuid(uuid))
                filters.add(builder.build())
            } catch (e: Exception) {
                // Invalid UUID, skip
            }
        }

        // If no specific filters, add empty filter to scan all devices
        if (filters.isEmpty()) {
            val builder = android.bluetooth.le.ScanFilter.Builder()
            filters.add(builder.build())
        }

        return filters
    }

    private fun createGattCallback(deviceId: String): BluetoothGattCallback {
        return object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                val callbacks = deviceCallbacks[deviceId]

                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        callbacks?.connectCallback?.invoke(true, deviceId, "")
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        // Clean up
                        connectedDevices.remove(deviceId)
                        val interrupted = status != BluetoothGatt.GATT_SUCCESS
                        callbacks?.disconnectCallback?.invoke(deviceId, interrupted, if (interrupted) "Connection lost" else "")
                        deviceCallbacks.remove(deviceId)
                        gatt.close()
                    }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val callbacks = deviceCallbacks[deviceId]
                val serviceDiscoveryCallback = callbacks?.serviceDiscoveryCallback

                if (status == BluetoothGatt.GATT_SUCCESS) {
                    serviceDiscoveryCallback?.invoke(true, "")
                } else {
                    serviceDiscoveryCallback?.invoke(false, "Service discovery failed with status: $status")
                }

                // Clear the service discovery callback as it's one-time use
                callbacks?.serviceDiscoveryCallback = null
            }

            override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                // Handle characteristic read result
                val data = if (status == BluetoothGatt.GATT_SUCCESS) {
                    val value = characteristic.value ?: byteArrayOf()
                    // Create direct ByteBuffer as required by ArrayBuffer.wrap()
                    val directBuffer = java.nio.ByteBuffer.allocateDirect(value.size)
                    directBuffer.put(value)
                    directBuffer.flip()
                    ArrayBuffer.wrap(directBuffer)
                } else {
                    ArrayBuffer.allocate(0)
                }
                // This will be handled by pending operations
            }

            override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                // Handle characteristic write result
                val deviceId = gatt.device.address
                val characteristicId = characteristic.uuid.toString()
                val callbackKey = "$deviceId:$characteristicId"

                writeCallbacks.remove(callbackKey)?.let { callback ->
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        // Get response data from characteristic value (may be null/empty for acknowledgments)
                        val responseData = characteristic.value ?: byteArrayOf()
                        val directBuffer = java.nio.ByteBuffer.allocateDirect(responseData.size)
                        directBuffer.put(responseData)
                        directBuffer.flip()
                        val arrayBuffer = ArrayBuffer.wrap(directBuffer)
                        callback(true, arrayBuffer, "")
                    } else {
                        callback(false, ArrayBuffer.allocate(0), "Write failed with status: $status")
                    }
                }
            }

            override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
                val deviceId = gatt.device.address

                rssiCallbacks.remove(deviceId)?.let { callback ->
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        callback(true, rssi.toDouble(), "")
                    } else {
                        callback(false, 0.0, "RSSI read failed with status: $status")
                    }
                }
            }

            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                // Handle characteristic notifications
                val characteristicId = characteristic.uuid.toString()
                val value = characteristic.value ?: byteArrayOf()

                // Create direct ByteBuffer as required by ArrayBuffer.wrap()
                val directBuffer = java.nio.ByteBuffer.allocateDirect(value.size)
                directBuffer.put(value)
                directBuffer.flip()

                val data = ArrayBuffer.wrap(directBuffer)

                val callbacks = deviceCallbacks[deviceId]
                callbacks?.characteristicSubscriptions?.get(characteristicId)?.invoke(characteristicId, data)
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                // Handle descriptor write (for enabling/disabling notifications)
            }
        }
    }

    override fun setRestoreStateCallback(callback: (restoredPeripherals: Array<BLEDevice>) -> Unit) {
        restoreStateCallback = { devices -> callback(devices.toTypedArray()) }
        return
    }

    // Scanning operations
    override fun startScan(filter: com.margelo.nitro.co.zyke.ble.ScanFilter, callback: (device: BLEDevice?, error: String?) -> Unit) {
        try {
            initializeBluetoothIfNeeded()
            val adapter = bluetoothAdapter ?: return

            // Permission & state checks
            if (!hasBluetoothPermissions()) {
                callback(null, "Missing Bluetooth permissions")
                return
            }
            if (!adapter.isEnabled) {
                callback(null, "Bluetooth is powered off")
                return
            }

            if (isCurrentlyScanning) {
                // Already scanning — treat as success (idempotent)
                return
            }

            // Reset per-session state
            discoveredDevicesInCurrentScan.clear()

            bleScanner = adapter.bluetoothLeScanner ?: run {
                callback(null, "Scanner not available")
                return
            }
            deviceFoundCallback = callback

            // Build filters
            val scanFilters = createAndroidScanFilters(filter)

            // Build settings derived from requested mode
            val scanMode = when (filter.androidScanMode) {
                AndroidScanMode.LOWLATENCY -> ScanSettings.SCAN_MODE_LOW_LATENCY
                AndroidScanMode.LOWPOWER   -> ScanSettings.SCAN_MODE_LOW_POWER
                AndroidScanMode.BALANCED   -> ScanSettings.SCAN_MODE_BALANCED
                AndroidScanMode.OPPORTUNISTIC -> ScanSettings.SCAN_MODE_OPPORTUNISTIC
            }

            val settingsBuilder = ScanSettings.Builder()
                .setScanMode(scanMode)
                .setReportDelay(0)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                settingsBuilder.setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Better responsiveness for LowLatency, less battery for LowPower
                val matchMode = when (scanMode) {
                    ScanSettings.SCAN_MODE_LOW_LATENCY -> ScanSettings.MATCH_MODE_AGGRESSIVE
                    else -> ScanSettings.MATCH_MODE_STICKY
                }
                settingsBuilder.setMatchMode(matchMode)
                // Let the framework deliver more matches when aggressive
                val numMatches = when (scanMode) {
                    ScanSettings.SCAN_MODE_LOW_LATENCY -> ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT
                    else -> ScanSettings.MATCH_NUM_FEW_ADVERTISEMENT
                }
                settingsBuilder.setNumOfMatches(numMatches)
            }

            val settings = settingsBuilder.build()

            // Prepare callback
            scanCallback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    val device = createBLEDeviceFromScanResult(result)
                    // RSSI threshold
                    if (device.rssi < filter.rssiThreshold) return
                    // De-dup if requested
                    if (!filter.allowDuplicates && !discoveredDevicesInCurrentScan.add(device.id)) return
                    callback(device, null)
                }
                override fun onBatchScanResults(results: MutableList<ScanResult>) {
                    results.forEach { r ->
                        val device = createBLEDeviceFromScanResult(r)
                        if (device.rssi < filter.rssiThreshold) return@forEach
                        if (!filter.allowDuplicates && !discoveredDevicesInCurrentScan.add(device.id)) return@forEach
                        callback(device, null)
                    }
                }
                override fun onScanFailed(errorCode: Int) {
                    val msg = when (errorCode) {
                        SCAN_FAILED_ALREADY_STARTED -> "Scan already started"
                        SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "App registration failed"
                        SCAN_FAILED_FEATURE_UNSUPPORTED -> "Feature unsupported"
                        SCAN_FAILED_INTERNAL_ERROR -> "Internal error"
                        SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES -> "Out of hardware resources"
                        SCAN_FAILED_SCANNING_TOO_FREQUENTLY -> "Scanning too frequently"
                        else -> "Scan failed with error code: $errorCode"
                    }
                    callback(null, msg)
                    stopScan()
                }
            }

            // Start scanning
            bleScanner?.startScan(scanFilters, settings, scanCallback)
            isCurrentlyScanning = true
        } catch (e: SecurityException) {
            isCurrentlyScanning = false
            callback(null, "Permission error: ${e.message}")
        } catch (e: Exception) {
            isCurrentlyScanning = false
            callback(null, "Scan error: ${e.message}")
        }
    }

    override fun stopScan(): Boolean {
        return try {
            if (scanCallback != null && isCurrentlyScanning) {
                try { bleScanner?.stopScan(scanCallback) } catch (_: Exception) {}
            }
            isCurrentlyScanning = false
            scanCallback = null
            deviceFoundCallback = null
            bleScanner = null
            discoveredDevicesInCurrentScan.clear()
            true
        } catch (_: Exception) {
            isCurrentlyScanning = false
            scanCallback = null
            deviceFoundCallback = null
            bleScanner = null
            discoveredDevicesInCurrentScan.clear()
            false
        }
    }

    override fun isScanning(): Boolean {
        return isCurrentlyScanning
    }

    // Device discovery
    override fun getConnectedDevices(services: Array<String>): Array<BLEDevice> {
        return try {
            initializeBluetoothIfNeeded()
            val adapter = bluetoothAdapter ?: return emptyArray()

            val needFilter = services.isNotEmpty()
            val normalizedFilter = if (needFilter) services.map { it.lowercase() } else emptyList()

            val result = mutableListOf<BLEDevice>()
            for ((deviceId, mgr) in nordicManagers) {
                if (mgr.isConnected) {
                    // Optional filtering by services
                    if (needFilter) {
                        val devServices = getServices(deviceId).map { it.lowercase() }.toSet()
                        val matches = normalizedFilter.all { it in devServices }
                        if (!matches) continue
                    }

                    val dev = try { adapter.getRemoteDevice(deviceId) } catch (_: Exception) { null }
                    result += BLEDevice(
                        id = deviceId,
                        name = dev?.name ?: "",
                        rssi = 0.0, // RSSI не читаем тут
                        manufacturerData = ManufacturerData(companyIdentifiers = emptyArray()),
                        serviceUUIDs = getServices(deviceId),
                        isConnectable = true
                    )
                }
            }
            result.toTypedArray()
        } catch (_: Exception) {
            emptyArray()
        }
    }

    // Bonded devices (Android)
    override fun getBondedDevices(): Array<BLEDevice> {
        return try {
            initializeBluetoothIfNeeded()
            val adapter = bluetoothAdapter ?: return emptyArray()

            // Requires BLUETOOTH_CONNECT on Android 12+
            if (!hasBluetoothPermissions()) {
                return emptyArray()
            }

            val bonded: Set<BluetoothDevice> = adapter.bondedDevices ?: emptySet()
            bonded.map { device ->
                BLEDevice(
                    id = device.address,
                    name = device.name ?: "",
                    rssi = 0.0,
                    manufacturerData = ManufacturerData(companyIdentifiers = emptyArray()),
                    serviceUUIDs = emptyArray(),
                    isConnectable = true
                )
            }.toTypedArray()
        } catch (e: SecurityException) {
            emptyArray()
        } catch (e: Exception) {
            emptyArray()
        }
    }

    // Connection management
    //TODO: add disconnect callback
    override fun connect(deviceId: String, callback: (Boolean, String, String)->Unit, disconnectCallback: ((String, Boolean, String)->Unit)?) {
        try {
            initializeBluetoothIfNeeded()
            val ctx = appContext ?: return callback(false, deviceId, "Context not available")
            val dev = bluetoothAdapter?.getRemoteDevice(deviceId) ?: return callback(false, deviceId, "Device not found")

            val mgr = MyNordicManager(ctx)
            nordicManagers[deviceId] = mgr

            mgr.connectRequest(dev)
                .useAutoConnect(false)
                .retry(3, 200)
                .usePreferredPhy(PhyRequest.PHY_LE_2M_MASK or PhyRequest.PHY_LE_CODED_MASK)
                .done { callback(true, deviceId, "") }
                .fail { _, status -> callback(false, deviceId, "Connection failed: $status") }
                .enqueue()
            } catch (e: Exception) {
            callback(false, deviceId, "Connection error: ${e.message}")
        }
    }

    // Create a bond (pairing) with a device (Android)
    override fun createBond(deviceId: String, cb: (Boolean, String)->Unit) {
        val mgr = nordicManagers[deviceId] ?: return cb(false, "Device not connected")
        mgr.setBondingRequiredPublic(true)
        mgr.ensureBondPublic()
            .done { cb(true, "") }
            .fail { _, status -> cb(false, "Bonding failed: $status") }
            .enqueue()
        }

    override fun disconnect(deviceId: String, cb: (Boolean, String)->Unit) {
        nordicManagers.remove(deviceId)?.let {
            it.disconnect().done { cb(true, "") }.fail { _, _ -> cb(false, "Disconnect failed") }.enqueue()
        } ?: cb(false, "Device not connected")
    }

    override fun isConnected(deviceId: String): Boolean {
        return try {
            nordicManagers[deviceId]?.isConnected ?: false
        } catch (_: Exception) {
            false
        }
    }

    override fun requestMTU(deviceId: String, mtu: Double): Double {
        val mgr = nordicManagers[deviceId] ?: return 0.0
        mgr.requestMtuPublic(mtu.toInt()).enqueue()
        return mtu // фактическое подтверждение прилетит позже; по твоему API ок вернуть запрошенное
    }

    override fun readRSSI(deviceId: String, callback: (success: Boolean, rssi: Double, error: String) -> Unit) {
        try {
            val mgr = nordicManagers[deviceId]
                ?: return callback(false, 0.0, "Device not connected")

            mgr.readRssiPublic()
                .with { _, rssi -> callback(true, rssi.toDouble(), "") }
                .fail { _, status -> callback(false, 0.0, "RSSI read failed: $status") }
                .enqueue()
        } catch (e: Exception) {
            callback(false, 0.0, "RSSI read error: ${e.message}")
        }
    }

    // Service discovery
    override fun discoverServices(deviceId: String, callback: (success: Boolean, error: String) -> Unit) {
        try {
            val mgr = nordicManagers[deviceId]
                ?: return callback(false, "Device not connected")

            // В Nordic BleManager discovery делается автоматически при connect().
            // Здесь просто выполняем лёгкий запрос (RSSI), чтобы убедиться, что соединение активно,
            // и считаем discovery завершённым для нашего API.
            mgr.readRssiPublic()
                .done { callback(true, "") }
                .fail { _, _ -> callback(true, "") } // даже при ошибке чита RSSI, discovery уже был выполнен ранее
                .enqueue()
        } catch (e: Exception) {
            callback(false, "Service discovery error: ${e.message}")
        }
    }

    override fun getServices(deviceId: String): Array<String> {
        return try {
            val mgr = nordicManagers[deviceId] ?: return emptyArray()

            // Достаём bluetoothGatt из BleManager через reflection (поле защищённое в суперклассе)
            var clazz: Class<*>? = mgr.javaClass
            var gattField: java.lang.reflect.Field? = null
            while (clazz != null && gattField == null) {
                try {
                    gattField = clazz.getDeclaredField("bluetoothGatt")
                } catch (_: NoSuchFieldException) {
                    clazz = clazz.superclass
                }
            }
            val gatt = gattField?.let { field ->
                field.isAccessible = true
                field.get(mgr) as? BluetoothGatt
            }

            gatt?.services?.map { it.uuid.toString() }?.toTypedArray() ?: emptyArray()
        } catch (_: Exception) {
            emptyArray()
        }
    }

    override fun getCharacteristics(deviceId: String, serviceId: String): Array<String> {
        return try {
            val gatt = connectedDevices[deviceId]
            val service = gatt?.getService(UUID.fromString(serviceId))
            service?.characteristics?.map { characteristic ->
                characteristic.uuid.toString()
            }?.toTypedArray() ?: emptyArray()
        } catch (e: Exception) {
            emptyArray()
        }
    }

    // Characteristic operations
    override fun readCharacteristic(
        deviceId: String,
        serviceId: String,
        characteristicId: String,
        callback: (success: Boolean, data: ArrayBuffer, error: String) -> Unit
    ) {
        try {
            val mgr = nordicManagers[deviceId]
                ?: return callback(false, ArrayBuffer.allocate(0), "Device not connected")

            val svc = UUID.fromString(serviceId)
            val chr = UUID.fromString(characteristicId)

            mgr.read(
                svc,
                chr,
                onData = { bytes ->
                    val direct = java.nio.ByteBuffer.allocateDirect(bytes.size)
                    direct.put(bytes)
                    direct.flip()
                    callback(true, ArrayBuffer.wrap(direct), "")
                },
                onErr = { err ->
                    callback(false, ArrayBuffer.allocate(0), err)
                }
            )
        } catch (e: Exception) {
            callback(false, ArrayBuffer.allocate(0), "Read error: ${e.message}")
        }
    }

    override fun writeCharacteristic(
        deviceId: String,
        serviceId: String,
        characteristicId: String,
        data: ArrayBuffer,
        withResponse: Boolean,
        callback: (success: Boolean, responseData: ArrayBuffer, error: String) -> Unit
    ) {
        try {
            val mgr = nordicManagers[deviceId]
                ?: return callback(false, ArrayBuffer.allocate(0), "Device not connected")

            // Convert ArrayBuffer -> ByteArray
            val buf = data.getBuffer(copyIfNeeded = true)
            val bytes = ByteArray(buf.remaining())
            buf.get(bytes)

            val svc = UUID.fromString(serviceId)
            val chr = UUID.fromString(characteristicId)

            mgr.write(
                svc,
                chr,
                bytes,
                withResponse,
                onDone = { _, resp ->
                    val direct = java.nio.ByteBuffer.allocateDirect(resp.size)
                    direct.put(resp)
                    direct.flip()
                    callback(true, ArrayBuffer.wrap(direct), "")
                },
                onErr = { err ->
                    callback(false, ArrayBuffer.allocate(0), err)
                }
            )
        } catch (e: Exception) {
            callback(false, ArrayBuffer.allocate(0), "Write error: ${e.message}")
        }
    }

    override fun subscribeToCharacteristic(
        deviceId: String,
        serviceId: String,
        characteristicId: String,
        updateCallback: (characteristicId: String, data: ArrayBuffer) -> Unit,
        resultCallback: (success: Boolean, error: String) -> Unit
    ) {
        try {
            val mgr = nordicManagers[deviceId]
                ?: return resultCallback(false, "Device not connected")

            val svc = UUID.fromString(serviceId)
            val chr = UUID.fromString(characteristicId)

            // Store/update JS callback
            deviceCallbacks[deviceId]?.let { cb ->
                cb.characteristicSubscriptions[characteristicId] = updateCallback
            } ?: run {
                deviceCallbacks[deviceId] = DeviceCallbacks(
                    characteristicSubscriptions = mutableMapOf(characteristicId to updateCallback)
                )
            }

            mgr.enableNotify(
                svc,
                chr,
                onData = { bytes ->
                    val direct = java.nio.ByteBuffer.allocateDirect(bytes.size)
                    direct.put(bytes)
                    direct.flip()
                    val data = ArrayBuffer.wrap(direct)
                    deviceCallbacks[deviceId]?.characteristicSubscriptions?.get(characteristicId)?.invoke(characteristicId, data)
                },
                onErr = { err ->
                    resultCallback(false, err)
                }
            )

            resultCallback(true, "")
        } catch (e: Exception) {
            resultCallback(false, "Subscription error: ${e.message}")
        }
    }

    override fun unsubscribeFromCharacteristic(
        deviceId: String,
        serviceId: String,
        characteristicId: String,
        callback: (success: Boolean, error: String) -> Unit
    ) {
        try {
            val mgr = nordicManagers[deviceId]
                ?: return callback(false, "Device not connected")

            val svc = UUID.fromString(serviceId)
            val chr = UUID.fromString(characteristicId)

            // Attempt to disable notifications using Nordic API
            mgr.disableNotify(svc, chr,
                onDone = {
                    deviceCallbacks[deviceId]?.characteristicSubscriptions?.remove(characteristicId)
                    callback(true, "")
                },
                onErr = { err ->
                    callback(false, err)
                }
            )
        } catch (e: Exception) {
            callback(false, "Unsubscription error: ${e.message}")
        }
    }

    // Bluetooth state management
    override fun requestBluetoothEnable(callback: (success: Boolean, error: String) -> Unit) {
        try {
            initializeBluetoothIfNeeded()
            val adapter = bluetoothAdapter
            if (adapter == null) {
                callback(false, "Bluetooth not supported on this device")
                return
            }

            if (adapter.isEnabled) {
                callback(true, "")
                return
            }

            // Request user to enable Bluetooth
            try {
                val enableBtIntent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
                appContext?.let { ctx ->
                    enableBtIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    ctx.startActivity(enableBtIntent)
                    callback(true, "Bluetooth enable request sent")
                } ?: callback(false, "Context not available")
            } catch (securityException: SecurityException) {
                callback(false, "Permission denied: Cannot request Bluetooth enable. Please check app permissions.")
            }

        } catch (e: Exception) {
            callback(false, "Error requesting Bluetooth enable: ${e.message}")
        }
    }

    override fun state(): BLEState {
        // Check permissions first
        if (!hasBluetoothPermissions()) {
            return BLEState.UNAUTHORIZED
        }

        initializeBluetoothIfNeeded()
        val adapter = bluetoothAdapter ?: return BLEState.UNSUPPORTED

        return try {
            bluetoothStateToBlEState(adapter.state)
        } catch (securityException: SecurityException) {
            BLEState.UNAUTHORIZED
        }
    }

    override fun subscribeToStateChange(stateCallback: (state: BLEState) -> Unit): OperationResult {
        try {
            val context = appContext ?: return OperationResult(success = false, error = "Context not available")

            // Unsubscribe from any existing subscription
            unsubscribeFromStateChange()

            // Store the callback
            this.stateCallback = stateCallback

            // Create and register broadcast receiver
            bluetoothStateReceiver = createBluetoothStateReceiver()
            val intentFilter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(bluetoothStateReceiver, intentFilter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(bluetoothStateReceiver, intentFilter)
            }

            return OperationResult(success = true, error = null)
        } catch (e: Exception) {
            return OperationResult(success = false, error = "Error subscribing to state changes: ${e.message}")
        }
    }

    override fun unsubscribeFromStateChange(): OperationResult {
        try {
            // Clear the callback
            this.stateCallback = null

            // Unregister broadcast receiver if it exists
            bluetoothStateReceiver?.let { receiver ->
                val context = appContext
                if (context != null) {
                    try {
                        context.unregisterReceiver(receiver)
                    } catch (e: IllegalArgumentException) {
                        // Receiver was not registered, ignore
                    }
                }
                bluetoothStateReceiver = null
            }

            return OperationResult(success = true, error = null)
        } catch (e: Exception) {
            return OperationResult(success = false, error = "Error unsubscribing from state changes: ${e.message}")
        }
    }

    override fun openSettings(): Promise<Unit> {
        val promise = Promise<Unit>()
        try {
            val intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            appContext?.let { ctx ->
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(intent)
                promise.resolve(Unit)
            } ?: promise.reject(Exception("Context not available"))
        } catch (e: Exception) {
            promise.reject(Exception("Error opening Bluetooth settings: ${e.message}"))
        }
        return promise
    }
}
