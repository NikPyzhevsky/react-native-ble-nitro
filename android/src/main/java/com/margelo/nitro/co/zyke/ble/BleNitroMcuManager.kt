package com.margelo.nitro.co.zyke.ble

import android.content.Context
import android.bluetooth.BluetoothDevice
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

            val callback = object : FirmwareUpgradeCallback<State> {

                override fun onUpgradeStarted(controller: FirmwareUpgradeController) {
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

                override fun onUpgradeCompleted() {
                    updateState(DfuState.COMPLETED)
                }

                override fun onUpgradeFailed(state: State?, error: McuMgrException?) {
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
