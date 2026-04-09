"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BleNitroManager = exports.AndroidScanMode = exports.BLEState = void 0;
exports.mapNativeBLEStateToBLEState = mapNativeBLEStateToBLEState;
exports.mapAndroidScanModeToNativeAndroidScanMode = mapAndroidScanModeToNativeAndroidScanMode;
exports.convertNativeBleDeviceToBleDevice = convertNativeBleDeviceToBleDevice;
exports.arrayBufferToByteArray = arrayBufferToByteArray;
exports.byteArrayToArrayBuffer = byteArrayToArrayBuffer;
const NativeBleNitro_1 = __importDefault(require("./specs/NativeBleNitro"));
const NativeBleNitro_2 = require("./specs/NativeBleNitro");
var BLEState;
(function (BLEState) {
    BLEState["Unknown"] = "Unknown";
    BLEState["Resetting"] = "Resetting";
    BLEState["Unsupported"] = "Unsupported";
    BLEState["Unauthorized"] = "Unauthorized";
    BLEState["PoweredOff"] = "PoweredOff";
    BLEState["PoweredOn"] = "PoweredOn";
})(BLEState || (exports.BLEState = BLEState = {}));
;
var AndroidScanMode;
(function (AndroidScanMode) {
    AndroidScanMode["LowLatency"] = "LowLatency";
    AndroidScanMode["Balanced"] = "Balanced";
    AndroidScanMode["LowPower"] = "LowPower";
    AndroidScanMode["Opportunistic"] = "Opportunistic";
})(AndroidScanMode || (exports.AndroidScanMode = AndroidScanMode = {}));
function mapNativeBLEStateToBLEState(nativeState) {
    const map = {
        0: BLEState.Unknown,
        1: BLEState.Resetting,
        2: BLEState.Unsupported,
        3: BLEState.Unauthorized,
        4: BLEState.PoweredOff,
        5: BLEState.PoweredOn,
    };
    return map[nativeState];
}
function mapAndroidScanModeToNativeAndroidScanMode(scanMode) {
    const map = {
        LowLatency: NativeBleNitro_2.AndroidScanMode.LowLatency,
        Balanced: NativeBleNitro_2.AndroidScanMode.Balanced,
        LowPower: NativeBleNitro_2.AndroidScanMode.LowPower,
        Opportunistic: NativeBleNitro_2.AndroidScanMode.Opportunistic,
    };
    return map[scanMode];
}
function convertNativeBleDeviceToBleDevice(nativeBleDevice) {
    return {
        ...nativeBleDevice,
        serviceUUIDs: BleNitroManager.normalizeGattUUIDs(nativeBleDevice.serviceUUIDs),
        manufacturerData: {
            companyIdentifiers: nativeBleDevice.manufacturerData.companyIdentifiers.map(entry => ({
                id: entry.id,
                data: arrayBufferToByteArray(entry.data)
            }))
        }
    };
}
function arrayBufferToByteArray(buffer) {
    return Array.from(new Uint8Array(buffer));
}
function byteArrayToArrayBuffer(data) {
    return new Uint8Array(data).buffer;
}
function logSharedSubscription(message) {
    void message;
}
class BleNitroManager {
    constructor(options) {
        this._isScanning = false;
        this._connectedDevices = {};
        this._sharedCharacteristicSubscriptions = {};
        this._nextSubscriptionListenerId = 1;
        this._restoredStateCallback = null;
        this._restoredState = null;
        this._restoredStateCallback = (options === null || options === void 0 ? void 0 : options.onRestoredState) || null;
        NativeBleNitro_1.default.setRestoreStateCallback((peripherals) => this.onNativeRestoreStateCallback(peripherals));
    }
    onNativeRestoreStateCallback(peripherals) {
        const bleDevices = peripherals.map((peripheral) => convertNativeBleDeviceToBleDevice(peripheral));
        if (this._restoredStateCallback) {
            this._restoredStateCallback(bleDevices);
        }
        else {
            this._restoredState = bleDevices;
        }
    }
    onRestoredState(callback) {
        if (this._restoredState) {
            callback(this._restoredState);
            this._restoredState = null;
        }
        this._restoredStateCallback = callback;
    }
    /**
     * Converts a 16- oder 32-Bit UUID to a 128-Bit UUID
     *
     * @param uuid 16-, 32- or 128-Bit UUID as string
     * @returns Full 128-Bit UUID
     */
    static normalizeGattUUID(uuid) {
        const cleanUuid = uuid.toLowerCase();
        // 128-Bit UUID → normalisieren
        if (cleanUuid.length === 36 && cleanUuid.includes("-")) {
            return cleanUuid;
        }
        // GATT-Service UUIDs
        // 16- oder 32-Bit UUID → 128-Bit UUID
        const padded = cleanUuid.padStart(8, "0");
        return `${padded}-0000-1000-8000-00805f9b34fb`;
    }
    static normalizeGattUUIDs(uuids) {
        return uuids.map((uuid) => BleNitroManager.normalizeGattUUID(uuid));
    }
    static createCharacteristicSubscriptionKey(deviceId, serviceId, characteristicId) {
        return [
            deviceId,
            BleNitroManager.normalizeGattUUID(serviceId),
            BleNitroManager.normalizeGattUUID(characteristicId),
        ].join('|');
    }
    describeListenerSources(subscription) {
        const sources = Array.from(subscription.listeners.values()).map((listener) => listener.source ?? 'unknown');
        return sources.length > 0 ? sources.join(',') : '-';
    }
    ensureCharacteristicSubscription(subscriptionKey, subscription) {
        if (subscription.nativeSubscribed ||
            subscription.nativeSubscribePending ||
            subscription.nativeUnsubscribePending) {
            logSharedSubscription(`skip ensure key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)} nativeSubscribed=${subscription.nativeSubscribed} subscribePending=${subscription.nativeSubscribePending} unsubscribePending=${subscription.nativeUnsubscribePending}`);
            return;
        }
        logSharedSubscription(`native subscribe start key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`);
        subscription.nativeSubscribePending = true;
        NativeBleNitro_1.default.subscribeToCharacteristic(subscription.deviceId, subscription.serviceId, subscription.characteristicId, (charId, data) => {
            const currentSubscription = this._sharedCharacteristicSubscriptions[subscriptionKey];
            if (!currentSubscription) {
                return;
            }
            const byteArray = arrayBufferToByteArray(data);
            currentSubscription.listeners.forEach((listener) => {
                listener.callback(charId, byteArray);
            });
        }, (success, error) => {
            const currentSubscription = this._sharedCharacteristicSubscriptions[subscriptionKey];
            if (!currentSubscription) {
                return;
            }
            currentSubscription.nativeSubscribePending = false;
            if (!success) {
                logSharedSubscription(`native subscribe failed key=${subscriptionKey} listeners=${currentSubscription.listeners.size} sources=${this.describeListenerSources(currentSubscription)} error=${error}`);
                console.warn(`[BleNitro] subscribeToCharacteristic failed: ${error}`);
                if (currentSubscription.listeners.size === 0) {
                    delete this._sharedCharacteristicSubscriptions[subscriptionKey];
                }
                return;
            }
            currentSubscription.nativeSubscribed = true;
            logSharedSubscription(`native subscribe success key=${subscriptionKey} listeners=${currentSubscription.listeners.size} sources=${this.describeListenerSources(currentSubscription)}`);
            if (currentSubscription.listeners.size === 0) {
                this.teardownCharacteristicSubscription(subscriptionKey, currentSubscription);
            }
        });
    }
    teardownCharacteristicSubscription(subscriptionKey, subscription) {
        if (subscription.nativeUnsubscribePending) {
            logSharedSubscription(`skip native unsubscribe pending key=${subscriptionKey} sources=${this.describeListenerSources(subscription)}`);
            return;
        }
        if (!subscription.nativeSubscribed) {
            logSharedSubscription(`skip native unsubscribe because not subscribed key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)} subscribePending=${subscription.nativeSubscribePending}`);
            if (!subscription.nativeSubscribePending && subscription.listeners.size === 0) {
                delete this._sharedCharacteristicSubscriptions[subscriptionKey];
            }
            return;
        }
        logSharedSubscription(`native unsubscribe start key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`);
        subscription.nativeUnsubscribePending = true;
        NativeBleNitro_1.default.unsubscribeFromCharacteristic(subscription.deviceId, subscription.serviceId, subscription.characteristicId, (success, error) => {
            const currentSubscription = this._sharedCharacteristicSubscriptions[subscriptionKey];
            if (!currentSubscription) {
                return;
            }
            currentSubscription.nativeUnsubscribePending = false;
            currentSubscription.nativeSubscribed = false;
            logSharedSubscription(`native unsubscribe done key=${subscriptionKey} listeners=${currentSubscription.listeners.size} sources=${this.describeListenerSources(currentSubscription)} success=${success}`);
            if (!success) {
                console.warn(`[BleNitro] unsubscribeFromCharacteristic failed: ${error}`);
            }
            if (currentSubscription.listeners.size > 0) {
                this.ensureCharacteristicSubscription(subscriptionKey, currentSubscription);
                return;
            }
            if (!currentSubscription.nativeSubscribePending) {
                delete this._sharedCharacteristicSubscriptions[subscriptionKey];
            }
        });
    }
    removeCharacteristicListener(subscriptionKey, listenerId) {
        const subscription = this._sharedCharacteristicSubscriptions[subscriptionKey];
        if (!subscription) {
            return;
        }
        const listener = subscription.listeners.get(listenerId);
        subscription.listeners.delete(listenerId);
        logSharedSubscription(`listener removed key=${subscriptionKey} listenerId=${listenerId} source=${(listener?.source) ?? 'unknown'} remaining=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`);
        if (subscription.listeners.size > 0) {
            logSharedSubscription(`keep native subscription key=${subscriptionKey} remaining=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`);
            return;
        }
        if (subscription.nativeSubscribePending) {
            return;
        }
        if (subscription.nativeUnsubscribePending) {
            return;
        }
        if (!subscription.nativeSubscribed) {
            logSharedSubscription(`delete empty shared subscription key=${subscriptionKey} sources=-`);
            delete this._sharedCharacteristicSubscriptions[subscriptionKey];
            return;
        }
        this.teardownCharacteristicSubscription(subscriptionKey, subscription);
    }
    clearCharacteristicSubscriptionsForDevice(deviceId) {
        Object.keys(this._sharedCharacteristicSubscriptions).forEach((subscriptionKey) => {
            const subscription = this._sharedCharacteristicSubscriptions[subscriptionKey];
            if (subscription.deviceId === deviceId) {
                logSharedSubscription(`clear device subscriptions deviceId=${deviceId} key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`);
                delete this._sharedCharacteristicSubscriptions[subscriptionKey];
            }
        });
    }
    /**
     * Start scanning for Bluetooth devices
     * @param filter Optional scan filter
     * @param callback Callback function called when a device is found
     * @returns Promise resolving to success state
     */
    startScan(filter = {}, callback, onError) {
        var _a, _b, _c;
        if (this._isScanning) {
            return;
        }
        // Create native scan filter with defaults
        const nativeFilter = {
            serviceUUIDs: filter.serviceUUIDs || [],
            rssiThreshold: (_a = filter.rssiThreshold) !== null && _a !== void 0 ? _a : -100,
            allowDuplicates: (_b = filter.allowDuplicates) !== null && _b !== void 0 ? _b : false,
            androidScanMode: mapAndroidScanModeToNativeAndroidScanMode((_c = filter.androidScanMode) !== null && _c !== void 0 ? _c : AndroidScanMode.Balanced),
        };
        // Create callback wrapper
        const scanCallback = (device, error) => {
            if (error && !device) {
                this._isScanning = false;
                onError === null || onError === void 0 ? void 0 : onError(error);
                return;
            }
            device = device; // eslint-disable-line @typescript-eslint/no-non-null-assertion
            // Convert manufacturer data to Uint8Arrays
            const convertedDevice = convertNativeBleDeviceToBleDevice(device);
            callback(convertedDevice);
        };
        // Start scan
        NativeBleNitro_1.default.startScan(nativeFilter, scanCallback);
        this._isScanning = true;
    }
    /**
     * Stop scanning for Bluetooth devices
     * @returns Promise resolving to success state
     */
    stopScan() {
        if (!this._isScanning) {
            return;
        }
        NativeBleNitro_1.default.stopScan();
        this._isScanning = false;
    }
    /**
     * Check if currently scanning for devices
     * @returns Promise resolving to scanning state
     */
    isScanning() {
        this._isScanning = NativeBleNitro_1.default.isScanning();
        return this._isScanning;
    }
    /**
     * Get all currently connected devices
     * @param services Optional list of service UUIDs to filter by
     * @returns Array of connected devices
     */
    getConnectedDevices(services) {
        const devices = NativeBleNitro_1.default.getConnectedDevices(services || []);
        // Normalize service UUIDs - manufacturer data already comes as ArrayBuffers
        return devices.map(device => convertNativeBleDeviceToBleDevice(device));
    }
    /**
     * Get OS-bonded (paired) devices (Android only)
     * @returns Array of bonded devices
     */
    getBondedDevices() {
        const devices = NativeBleNitro_1.default.getBondedDevices();
        return devices.map(device => convertNativeBleDeviceToBleDevice(device));
    }
    /**
     * Connect to a Bluetooth device
     * @param deviceId ID of the device to connect to
     * @param onDisconnect Optional callback for disconnect events
     * @returns Promise resolving when connected
     */
    connect(deviceId, onDisconnect) {
        return new Promise((resolve, reject) => {
            // Check if already connected
            if (this._connectedDevices[deviceId]) {
                resolve(deviceId);
                return;
            }
            NativeBleNitro_1.default.connect(deviceId, (success, connectedDeviceId, error) => {
                if (success) {
                    this._connectedDevices[deviceId] = true;
                    resolve(connectedDeviceId);
                }
                else {
                    reject(new Error(error));
                }
            }, onDisconnect ? (deviceId, interrupted, error) => {
                // Remove from connected devices when disconnected
                delete this._connectedDevices[deviceId];
                this.clearCharacteristicSubscriptionsForDevice(deviceId);
                onDisconnect(deviceId, interrupted, error);
            } : undefined);
        });
    }
    /**
     * Initiate bonding (pairing) with a device (Android only)
     * @param deviceId ID of the device to bond with
     * @returns Promise resolving when bonding is initiated/completed successfully
     */
    createBond(deviceId) {
        return new Promise((resolve, reject) => {
            NativeBleNitro_1.default.createBond(deviceId, (success, error) => {
                if (success) {
                    resolve();
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Disconnect from a Bluetooth device
     * @param deviceId ID of the device to disconnect from
     * @returns Promise resolving when disconnected
     */
    disconnect(deviceId) {
        return new Promise((resolve, reject) => {
            // Check if already disconnected
            if (!this._connectedDevices[deviceId]) {
                this.clearCharacteristicSubscriptionsForDevice(deviceId);
                resolve();
                return;
            }
            NativeBleNitro_1.default.disconnect(deviceId, (success, error) => {
                if (success) {
                    delete this._connectedDevices[deviceId];
                    this.clearCharacteristicSubscriptionsForDevice(deviceId);
                    resolve();
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Check if connected to a device
     * @param deviceId ID of the device to check
     * @returns Promise resolving to connection state
     */
    isConnected(deviceId) {
        return NativeBleNitro_1.default.isConnected(deviceId);
    }
    /**
     * Request a new MTU size
     * @param deviceId ID of the device
     * @param mtu New MTU size, min is 23, max is 517
     * @returns On Android: new MTU size; on iOS: current MTU size as it is handled by iOS itself; on error: -1
     */
    requestMTU(deviceId, mtu) {
        mtu = parseInt(mtu.toString(), 10);
        const deviceMtu = NativeBleNitro_1.default.requestMTU(deviceId, mtu);
        return deviceMtu;
    }
    /**
     * Read RSSI for a connected device
     * @param deviceId ID of the device
     * @returns Promise resolving to RSSI value
     */
    readRSSI(deviceId) {
        return new Promise((resolve, reject) => {
            // Check if connected first
            if (!this._connectedDevices[deviceId]) {
                reject(new Error('Device not connected'));
                return;
            }
            NativeBleNitro_1.default.readRSSI(deviceId, (success, rssi, error) => {
                if (success) {
                    resolve(rssi);
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Discover services for a connected device
     * @param deviceId ID of the device
     * @returns Promise resolving when services are discovered
     */
    discoverServices(deviceId) {
        return new Promise((resolve, reject) => {
            // Check if connected first
            if (!this._connectedDevices[deviceId]) {
                reject(new Error('Device not connected'));
                return;
            }
            NativeBleNitro_1.default.discoverServices(deviceId, (success, error) => {
                if (success) {
                    resolve(true);
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Get services for a connected device
     * @param deviceId ID of the device
     * @returns Promise resolving to array of service UUIDs
     */
    getServices(deviceId) {
        return new Promise(async (resolve, reject) => {
            // Check if connected first
            if (!this._connectedDevices[deviceId]) {
                reject(new Error('Device not connected'));
                return;
            }
            const success = await this.discoverServices(deviceId);
            if (!success) {
                reject(new Error('Failed to discover services'));
                return;
            }
            const services = NativeBleNitro_1.default.getServices(deviceId);
            resolve(BleNitroManager.normalizeGattUUIDs(services));
        });
    }
    /**
     * Get characteristics for a service
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @returns Promise resolving to array of characteristic UUIDs
     */
    getCharacteristics(deviceId, serviceId) {
        if (!this._connectedDevices[deviceId]) {
            throw new Error('Device not connected');
        }
        const characteristics = NativeBleNitro_1.default.getCharacteristics(deviceId, BleNitroManager.normalizeGattUUID(serviceId));
        return BleNitroManager.normalizeGattUUIDs(characteristics);
    }
    /**
     * Read a characteristic value
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @returns Promise resolving to the characteristic data as ArrayBuffer
     */
    readCharacteristic(deviceId, serviceId, characteristicId) {
        return new Promise((resolve, reject) => {
            // Check if connected first
            if (!this._connectedDevices[deviceId]) {
                reject(new Error('Device not connected'));
                return;
            }
            NativeBleNitro_1.default.readCharacteristic(deviceId, BleNitroManager.normalizeGattUUID(serviceId), BleNitroManager.normalizeGattUUID(characteristicId), (success, data, error) => {
                if (success) {
                    resolve(arrayBufferToByteArray(data));
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Write a value to a characteristic
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @param data Data to write as ByteArray (number[])
     * @param withResponse Whether to wait for response
     * @returns Promise resolving with response data (empty ByteArray when withResponse=false)
     */
    writeCharacteristic(deviceId, serviceId, characteristicId, data, withResponse = true) {
        return new Promise((resolve, reject) => {
            // Check if connected first
            if (!this._connectedDevices[deviceId]) {
                reject(new Error('Device not connected'));
                return;
            }
            NativeBleNitro_1.default.writeCharacteristic(deviceId, BleNitroManager.normalizeGattUUID(serviceId), BleNitroManager.normalizeGattUUID(characteristicId), byteArrayToArrayBuffer(data), withResponse, (success, responseData, error) => {
                if (success) {
                    // Convert ArrayBuffer response to ByteArray
                    const responseByteArray = arrayBufferToByteArray(responseData);
                    resolve(responseByteArray);
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Subscribe to characteristic notifications
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @param callback Callback function called when notification is received
     * @returns Promise resolving when subscription is complete
     */
    subscribeToCharacteristic(deviceId, serviceId, characteristicId, callback, debugSource) {
        // Check if connected first
        if (!this._connectedDevices[deviceId]) {
            throw new Error('Device not connected');
        }
        const normalizedServiceId = BleNitroManager.normalizeGattUUID(serviceId);
        const normalizedCharacteristicId = BleNitroManager.normalizeGattUUID(characteristicId);
        const subscriptionKey = BleNitroManager.createCharacteristicSubscriptionKey(deviceId, normalizedServiceId, normalizedCharacteristicId);
        let subscription = this._sharedCharacteristicSubscriptions[subscriptionKey];
        if (!subscription) {
            subscription = {
                deviceId,
                serviceId: normalizedServiceId,
                characteristicId: normalizedCharacteristicId,
                listeners: new Map(),
                nativeSubscribed: false,
                nativeSubscribePending: false,
                nativeUnsubscribePending: false,
            };
            this._sharedCharacteristicSubscriptions[subscriptionKey] = subscription;
        }
        const listenerId = this._nextSubscriptionListenerId++;
        subscription.listeners.set(listenerId, {
            callback,
            source: debugSource,
        });
        logSharedSubscription(`listener added key=${subscriptionKey} listenerId=${listenerId} source=${debugSource ?? 'unknown'} total=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`);
        this.ensureCharacteristicSubscription(subscriptionKey, subscription);
        let removed = false;
        return {
            remove: () => {
                if (removed) {
                    return;
                }
                removed = true;
                this.removeCharacteristicListener(subscriptionKey, listenerId);
            }
        };
    }
    /**
     * Unsubscribe from characteristic notifications
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @returns Promise resolving when unsubscription is complete
     */
    unsubscribeFromCharacteristic(deviceId, serviceId, characteristicId) {
        return new Promise((resolve, reject) => {
            // Check if connected first
            if (!this._connectedDevices[deviceId]) {
                reject(new Error('Device not connected'));
                return;
            }
            NativeBleNitro_1.default.unsubscribeFromCharacteristic(deviceId, BleNitroManager.normalizeGattUUID(serviceId), BleNitroManager.normalizeGattUUID(characteristicId), (success, error) => {
                if (success) {
                    resolve();
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Check if Bluetooth is enabled
     * @returns Promise resolving to Bluetooth state
     */
    isBluetoothEnabled() {
        return this.state() === BLEState.PoweredOn;
    }
    /**
     * Request to enable Bluetooth (Android only)
     * @returns Promise resolving when Bluetooth is enabled
     */
    requestBluetoothEnable() {
        return new Promise((resolve, reject) => {
            NativeBleNitro_1.default.requestBluetoothEnable((success, error) => {
                if (success) {
                    resolve(true);
                }
                else {
                    reject(new Error(error));
                }
            });
        });
    }
    /**
     * Get the current Bluetooth state
     * @returns Promise resolving to Bluetooth state
     * @see BLEState
     */
    state() {
        return mapNativeBLEStateToBLEState(NativeBleNitro_1.default.state());
    }
    /**
     * Subscribe to Bluetooth state changes
     * @param callback Callback function called when state changes
     * @param emitInitial Whether to emit initial state callback
     * @returns Promise resolving when subscription is complete
     * @see BLEState
     */
    subscribeToStateChange(callback, emitInitial = false) {
        if (emitInitial) {
            const state = this.state();
            callback(state);
        }
        NativeBleNitro_1.default.subscribeToStateChange((nativeState) => {
            callback(mapNativeBLEStateToBLEState(nativeState));
        });
        return {
            remove: () => {
                NativeBleNitro_1.default.unsubscribeFromStateChange();
            },
        };
    }
    /**
     * Open Bluetooth settings
     * @returns Promise resolving when settings are opened
     */
    openSettings() {
        return NativeBleNitro_1.default.openSettings();
    }
    /**
     * Open Bluetooth settings
     * @returns Promise resolving when settings are opened
     */
    startBackgroundTask(callback, time, onClose) {
        return NativeBleNitro_1.default.startBackgroundTask(callback, time, onClose !== null && onClose !== void 0 ? onClose : (() => { }));
    }
    stopBackgroundTask() {
        return NativeBleNitro_1.default.stopBackgroundTask();
    }
    // ---------------------------------------------------------------------------
    // MCU Manager (DFU)
    // ---------------------------------------------------------------------------
    /**
     * Upload firmware package using MCU Manager (SMP).
     * The device must already be connected.
     *
     * @param deviceId BLE device id (already connected)
     * @param firmwarePath absolute path to .zip or .bin on the device filesystem
     */
    uploadMcuImage(deviceId, firmwarePath) {
        NativeBleNitro_1.default.uploadMcuImage(deviceId, firmwarePath);
    }
    /** Abort current DFU upload (if any). */
    abortMcuUpload() {
        NativeBleNitro_1.default.abortMcuUpload();
    }
    /** Read MCUboot image slots. */
    listMcuImages(deviceId) {
        return NativeBleNitro_1.default.listMcuImages(deviceId);
    }
    /** Mark image in slot as confirmed. */
    confirmMcuImage(deviceId, hash) {
        NativeBleNitro_1.default.confirmMcuImage(deviceId, hash);
    }
    /** Reset device after upload / confirm. */
    resetMcuDevice(deviceId) {
        NativeBleNitro_1.default.resetMcuDevice(deviceId);
    }
    /** Get current DFU state. */
    getMcuState() {
        return NativeBleNitro_1.default.getMcuState();
    }
    /** Subscribe to DFU state changes. */
    onMcuStateChanged(callback) {
        NativeBleNitro_1.default.onMcuStateChanged((state) => {
            callback(state);
        });
    }
    /** Subscribe to DFU progress updates. */
    onMcuProgress(callback) {
        NativeBleNitro_1.default.onMcuProgress((progress) => {
            callback(progress);
        });
    }
    /** Subscribe to DFU errors. */
    onMcuError(callback) {
        NativeBleNitro_1.default.onMcuError((error) => {
            callback(error);
        });
    }
}
exports.BleNitroManager = BleNitroManager;
//# sourceMappingURL=manager.js.map
