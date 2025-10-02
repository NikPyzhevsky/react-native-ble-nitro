package com.margelo.nitro.co.zyke.ble

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.content.Context
import no.nordicsemi.android.ble.BleManager
import no.nordicsemi.android.ble.Request
import no.nordicsemi.android.ble.WriteRequest
import no.nordicsemi.android.ble.MtuRequest
import no.nordicsemi.android.ble.ReadRssiRequest
import java.util.UUID

class MyNordicManager(ctx: Context) : BleManager(ctx) {
    private var gattRef: BluetoothGatt? = null

    override fun getGattCallback() = object : BleManagerGattCallback() {
        override fun isRequiredServiceSupported(gatt: BluetoothGatt): Boolean {
            gattRef = gatt
            return true
        }
        override fun initialize() {
            // Базовая инициализация – MTU. (bondingRequired(true) не зовем здесь)
            requestMtu(247).enqueue()
        }
        override fun onServicesInvalidated() {
            gattRef = null
        }
    }

    /** Безопасно получаем GATT через reflection (не трогаем protected-поле напрямую) */
private fun getGatt(): BluetoothGatt? = gattRef

    /** Публичная настройка требования бондинга (обертка над protected API) */
    fun setBondingRequiredPublic(required: Boolean) {
        try {
            val m = BleManager::class.java.getDeclaredMethod(
                "bondingRequired",
                java.lang.Boolean.TYPE
            )
            m.isAccessible = true
            m.invoke(this, required)
        } catch (_: Exception) { /* ignore */ }
    }

    /** Публичные обёртки над protected методами BleManager */
    fun ensureBondPublic(): Request = ensureBond()
    fun requestMtuPublic(mtu: Int): MtuRequest = requestMtu(mtu)
    fun readRssiPublic(): ReadRssiRequest = readRssi()
    fun connectRequest(device: android.bluetooth.BluetoothDevice) = connect(device)

    /** Read characteristic */
    fun read(
        uuidSvc: UUID,
        uuidChar: UUID,
        onData: (ByteArray) -> Unit,
        onErr: (String) -> Unit
    ) {
        val gatt = getGatt() ?: return onErr("No GATT available")

        val ch: BluetoothGattCharacteristic = gatt
            ?.getService(uuidSvc)
            ?.getCharacteristic(uuidChar)
            ?: return onErr("Characteristic not found: svc=" + uuidSvc.toString() + ", chr=" + uuidChar.toString())
        readCharacteristic(ch)
            .with { _, data -> onData(data.value ?: byteArrayOf()) }
            .fail { _, status -> onErr("Read failed: $status") }
            .enqueue()
    }

    /** Write characteristic */
    fun write(
        uuidSvc: UUID,
        uuidChar: UUID,
        bytes: ByteArray,
        withResp: Boolean,
        onDone: (Boolean, ByteArray) -> Unit,
        onErr: (String) -> Unit
    ) {
        val gatt = getGatt() ?: return onErr("No GATT available")

        val ch: BluetoothGattCharacteristic = gatt
            ?.getService(uuidSvc)
            ?.getCharacteristic(uuidChar)
            ?: return onErr("Characteristic not found: svc=" + uuidSvc.toString() + ", chr=" + uuidChar.toString())
val writeType = if (withResp)
    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
else
    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE

writeCharacteristic(ch, bytes, writeType)
    .with { _, data -> onDone(true, data.value ?: byteArrayOf()) }
    .fail { _, status -> onErr("Write failed: $status") }
    .enqueue()    }

    /** Enable notifications */
    fun enableNotify(
        uuidSvc: UUID,
        uuidChar: UUID,
        onData: (ByteArray) -> Unit,
        onErr: (String) -> Unit
    ) {
        val gatt = getGatt() ?: return onErr("No GATT available")

        val ch: BluetoothGattCharacteristic = gatt
            ?.getService(uuidSvc)
            ?.getCharacteristic(uuidChar)
            ?: return onErr("Characteristic not found: svc=" + uuidSvc.toString() + ", chr=" + uuidChar.toString())
        setNotificationCallback(ch).with { _, data -> onData(data.value ?: byteArrayOf()) }
        enableNotifications(ch)
            .fail { _, status -> onErr("Enable notify failed: $status") }
            .enqueue()
    }

    /** Disable notifications */
    fun disableNotify(
        uuidSvc: UUID,
        uuidChar: UUID,
        onDone: () -> Unit,
        onErr: (String) -> Unit
    ) {
        val gatt = getGatt() ?: return onErr("No GATT available")

        val ch: BluetoothGattCharacteristic = gatt
            ?.getService(uuidSvc)
            ?.getCharacteristic(uuidChar)
            ?: return onErr("Characteristic not found: svc=" + uuidSvc.toString() + ", chr=" + uuidChar.toString())
        disableNotifications(ch)
            .done { onDone() }
            .fail { _, status -> onErr("Disable notify failed: $status") }
            .enqueue()
    }
}
