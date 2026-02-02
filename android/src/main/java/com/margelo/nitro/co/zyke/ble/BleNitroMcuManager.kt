package com.margelo.nitro.co.zyke.ble

import android.Manifest
import android.content.Context
import android.bluetooth.BluetoothDevice
import android.util.Log
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import androidx.annotation.RequiresPermission
import io.runtime.mcumgr.ble.McuMgrBleTransport
import io.runtime.mcumgr.dfu.FirmwareUpgradeCallback
import io.runtime.mcumgr.dfu.mcuboot.FirmwareUpgradeManager.State
import io.runtime.mcumgr.dfu.FirmwareUpgradeController
import io.runtime.mcumgr.dfu.mcuboot.FirmwareUpgradeManager
import io.runtime.mcumgr.exception.McuMgrException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.ZipInputStream

class BleNitroMcuManager(
    private val context: Context
) {

    private companion object {
        private const val TAG = "BleNitroMcuManager"
    }

    private var dfuManager: FirmwareUpgradeManager? = null
    private val state = AtomicReference(DfuState.IDLE)

    private var stateCb: ((DfuState) -> Unit)? = null
    private var progressCb: ((DfuProgress) -> Unit)? = null
    private var errorCb: ((DfuError) -> Unit)? = null

    private fun unzip(zip: File, targetDir: File) {
        ZipInputStream(FileInputStream(zip)).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val outFile = File(targetDir, entry.name)
                if (entry.isDirectory) {
                    outFile.mkdirs()
                } else {
                    outFile.parentFile?.mkdirs()
                    FileOutputStream(outFile).use { zis.copyTo(it) }
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }

    fun upload(
        device: BluetoothDevice,
        firmwarePath: String
    ) {
        val zipFile = File(firmwarePath)
        if (!zipFile.exists()) {
            errorCb?.invoke(DfuError(-1.0, "Firmware ZIP not found"))
            return
        }

        // Create temp dir for unzip
        val tempDir = File(context.cacheDir, "dfu_${System.currentTimeMillis()}")
        tempDir.mkdirs()

        try {
            // Unzip package
            unzip(zipFile, tempDir)

            // Find .bin (single-image case)
            val binFile = tempDir.walkTopDown()
                .firstOrNull { it.isFile && it.extension == "bin" }
                ?: throw IllegalStateException("No .bin file found in ZIP")

            val imageBytes = binFile.readBytes()

            val transport = McuMgrBleTransport(context, device)
            Log.i(TAG, "DFU start over BLE (GATT). Device=" + device.address)

            val callback = object : FirmwareUpgradeCallback<State> {

                override fun onUpgradeStarted(controller: FirmwareUpgradeController) {
                    Log.i(TAG, "DFU upgrade started over BLE/GATT")
                    updateState(DfuState.CONNECTING)
                }

                override fun onStateChanged(prevState: State?, newState: State?) {
                    when (newState) {
                        State.NONE -> updateState(DfuState.IDLE)
                        State.UPLOAD -> updateState(DfuState.UPLOADING)
                        State.TEST, State.VALIDATE -> updateState(DfuState.VALIDATING)
                        State.CONFIRM -> updateState(DfuState.CONFIRMING)
                        State.RESET -> updateState(DfuState.RESETTING)
                        else -> {}
                    }
                }

                override fun onUploadProgressChanged(
                    bytesSent: Int,
                    imageSize: Int,
                    timestamp: Long
                ) {
                    val percent =
                        if (imageSize == 0) 0
                        else ((bytesSent * 100.0) / imageSize).toInt()

                    progressCb?.invoke(
                        DfuProgress(
                            percent = percent.toDouble(),
                            bytesSent = bytesSent.toDouble(),
                            bytesTotal = imageSize.toDouble()
                        )
                    )
                }

                @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
                override fun onUpgradeCompleted() {
                    Log.i(TAG, "DFU completed. Firmware uploaded successfully. Device rebooting (BLE/GATT will be invalid)")
                    updateState(DfuState.COMPLETED)

                    // Properly release mcumgr BLE transport (closes BluetoothGatt internally)
                    try {
                        Log.i(TAG, "Releasing McuMgr BLE transport")
                        dfuManager?.transporter?.release()
                    } catch (e: Exception) {
                        Log.w(TAG, "Error while releasing transport", e)
                    }

                    // Extra safety: force-close GATT using BluetoothDevice (Android BLE edge-case)
                    try {
                        Log.i(TAG, "Force closing GATT connection via BluetoothDevice")
                        val gatt = device.connectGatt(context, false, object : BluetoothGattCallback() {})
                        gatt.disconnect()
                        gatt.close()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to force-close GATT", e)
                    }

                    dfuManager = null
                }

                override fun onUpgradeFailed(state: State?, error: McuMgrException?) {
                    Log.e(TAG, "DFU failed at state=" + state + ", error=" + error?.message, error)
                    updateState(DfuState.ERROR)
                    errorCb?.invoke(
                        DfuError(
                            code = -1.0,
                            message = error?.message ?: "DFU failed"
                        )
                    )
                }

                override fun onUpgradeCanceled(state: State?) {
                    updateState(DfuState.ABORTED)
                }
            }

            dfuManager = FirmwareUpgradeManager(transport, callback).apply {
                setMode(FirmwareUpgradeManager.Mode.TEST_AND_CONFIRM)
            }

            val settings = FirmwareUpgradeManager.Settings.Builder()
                .setEraseAppSettings(false)
                .build()

            updateState(DfuState.CONNECTING)
            dfuManager?.start(imageBytes, settings)

        } catch (e: Exception) {
            updateState(DfuState.ERROR)
            errorCb?.invoke(
                DfuError(
                    code = -1.0,
                    message = e.message ?: "DFU failed"
                )
            )
        }
    }

    fun abort() {
        Log.w(TAG, "DFU aborted by user")
        dfuManager?.cancel()
    }

    fun getState(): DfuState = state.get()

    fun onState(cb: (DfuState) -> Unit) {
        stateCb = cb
    }

    fun onProgress(cb: (DfuProgress) -> Unit) {
        progressCb = cb
    }

    fun onError(cb: (DfuError) -> Unit) {
        errorCb = cb
    }

    private fun updateState(s: DfuState) {
        state.set(s)
        stateCb?.invoke(s)
    }
}
