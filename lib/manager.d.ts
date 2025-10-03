import { BLEDevice as NativeBLEDevice, BLEState as NativeBLEState, AndroidScanMode as NativeAndroidScanMode } from './specs/NativeBleNitro';
export type ByteArray = number[];
export interface ScanFilter {
    serviceUUIDs?: string[];
    rssiThreshold?: number;
    allowDuplicates?: boolean;
    androidScanMode?: AndroidScanMode;
}
export interface ManufacturerDataEntry {
    id: string;
    data: ByteArray;
}
export interface ManufacturerData {
    companyIdentifiers: ManufacturerDataEntry[];
}
export interface BLEDevice {
    id: string;
    name: string;
    rssi: number;
    manufacturerData: ManufacturerData;
    serviceUUIDs: string[];
    isConnectable: boolean;
}
export type ScanCallback = (device: BLEDevice) => void;
export type RestoreStateCallback = (connectedPeripherals: BLEDevice[]) => void;
export type ConnectionCallback = (success: boolean, deviceId: string, error: string) => void;
export type DisconnectEventCallback = (deviceId: string, interrupted: boolean, error: string) => void;
export type OperationCallback = (success: boolean, error: string) => void;
export type CharacteristicUpdateCallback = (characteristicId: string, data: ByteArray) => void;
export type Subscription = {
    remove: () => void;
};
export declare enum BLEState {
    Unknown = "Unknown",
    Resetting = "Resetting",
    Unsupported = "Unsupported",
    Unauthorized = "Unauthorized",
    PoweredOff = "PoweredOff",
    PoweredOn = "PoweredOn"
}
export declare enum AndroidScanMode {
    LowLatency = "LowLatency",
    Balanced = "Balanced",
    LowPower = "LowPower",
    Opportunistic = "Opportunistic"
}
export type BleNitroManagerOptions = {
    onRestoredState?: RestoreStateCallback;
};
export declare function mapNativeBLEStateToBLEState(nativeState: NativeBLEState): BLEState;
export declare function mapAndroidScanModeToNativeAndroidScanMode(scanMode: AndroidScanMode): NativeAndroidScanMode;
export declare function convertNativeBleDeviceToBleDevice(nativeBleDevice: NativeBLEDevice): BLEDevice;
export declare function arrayBufferToByteArray(buffer: ArrayBuffer): ByteArray;
export declare function byteArrayToArrayBuffer(data: ByteArray): ArrayBuffer;
export declare class BleNitroManager {
    private _isScanning;
    private _connectedDevices;
    private _restoredStateCallback;
    private _restoredState;
    constructor(options?: BleNitroManagerOptions);
    private onNativeRestoreStateCallback;
    onRestoredState(callback: RestoreStateCallback): void;
    /**
     * Converts a 16- oder 32-Bit UUID to a 128-Bit UUID
     *
     * @param uuid 16-, 32- or 128-Bit UUID as string
     * @returns Full 128-Bit UUID
     */
    static normalizeGattUUID(uuid: string): string;
    static normalizeGattUUIDs(uuids: string[]): string[];
    /**
     * Start scanning for Bluetooth devices
     * @param filter Optional scan filter
     * @param callback Callback function called when a device is found
     * @returns Promise resolving to success state
     */
    startScan(filter: ScanFilter | undefined, callback: ScanCallback, onError?: (error: string) => void): void;
    /**
     * Stop scanning for Bluetooth devices
     * @returns Promise resolving to success state
     */
    stopScan(): void;
    /**
     * Check if currently scanning for devices
     * @returns Promise resolving to scanning state
     */
    isScanning(): boolean;
    /**
     * Get all currently connected devices
     * @param services Optional list of service UUIDs to filter by
     * @returns Array of connected devices
     */
    getConnectedDevices(services?: string[]): BLEDevice[];
    /**
     * Get OS-bonded (paired) devices (Android only)
     * @returns Array of bonded devices
     */
    getBondedDevices(): BLEDevice[];
    /**
     * Connect to a Bluetooth device
     * @param deviceId ID of the device to connect to
     * @param onDisconnect Optional callback for disconnect events
     * @returns Promise resolving when connected
     */
    connect(deviceId: string, onDisconnect?: DisconnectEventCallback): Promise<string>;
    /**
     * Initiate bonding (pairing) with a device (Android only)
     * @param deviceId ID of the device to bond with
     * @returns Promise resolving when bonding is initiated/completed successfully
     */
    createBond(deviceId: string): Promise<void>;
    /**
     * Disconnect from a Bluetooth device
     * @param deviceId ID of the device to disconnect from
     * @returns Promise resolving when disconnected
     */
    disconnect(deviceId: string): Promise<void>;
    /**
     * Check if connected to a device
     * @param deviceId ID of the device to check
     * @returns Promise resolving to connection state
     */
    isConnected(deviceId: string): boolean;
    /**
     * Request a new MTU size
     * @param deviceId ID of the device
     * @param mtu New MTU size, min is 23, max is 517
     * @returns On Android: new MTU size; on iOS: current MTU size as it is handled by iOS itself; on error: -1
     */
    requestMTU(deviceId: string, mtu: number): number;
    /**
     * Read RSSI for a connected device
     * @param deviceId ID of the device
     * @returns Promise resolving to RSSI value
     */
    readRSSI(deviceId: string): Promise<number>;
    /**
     * Discover services for a connected device
     * @param deviceId ID of the device
     * @returns Promise resolving when services are discovered
     */
    discoverServices(deviceId: string): Promise<boolean>;
    /**
     * Get services for a connected device
     * @param deviceId ID of the device
     * @returns Promise resolving to array of service UUIDs
     */
    getServices(deviceId: string): Promise<string[]>;
    /**
     * Get characteristics for a service
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @returns Promise resolving to array of characteristic UUIDs
     */
    getCharacteristics(deviceId: string, serviceId: string): string[];
    /**
     * Read a characteristic value
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @returns Promise resolving to the characteristic data as ArrayBuffer
     */
    readCharacteristic(deviceId: string, serviceId: string, characteristicId: string): Promise<ByteArray>;
    /**
     * Write a value to a characteristic
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @param data Data to write as ByteArray (number[])
     * @param withResponse Whether to wait for response
     * @returns Promise resolving with response data (empty ByteArray when withResponse=false)
     */
    writeCharacteristic(deviceId: string, serviceId: string, characteristicId: string, data: ByteArray, withResponse?: boolean): Promise<ByteArray>;
    /**
     * Subscribe to characteristic notifications
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @param callback Callback function called when notification is received
     * @returns Promise resolving when subscription is complete
     */
    subscribeToCharacteristic(deviceId: string, serviceId: string, characteristicId: string, callback: CharacteristicUpdateCallback): Subscription;
    /**
     * Unsubscribe from characteristic notifications
     * @param deviceId ID of the device
     * @param serviceId ID of the service
     * @param characteristicId ID of the characteristic
     * @returns Promise resolving when unsubscription is complete
     */
    unsubscribeFromCharacteristic(deviceId: string, serviceId: string, characteristicId: string): Promise<void>;
    /**
     * Check if Bluetooth is enabled
     * @returns Promise resolving to Bluetooth state
     */
    isBluetoothEnabled(): boolean;
    /**
     * Request to enable Bluetooth (Android only)
     * @returns Promise resolving when Bluetooth is enabled
     */
    requestBluetoothEnable(): Promise<boolean>;
    /**
     * Get the current Bluetooth state
     * @returns Promise resolving to Bluetooth state
     * @see BLEState
     */
    state(): BLEState;
    /**
     * Subscribe to Bluetooth state changes
     * @param callback Callback function called when state changes
     * @param emitInitial Whether to emit initial state callback
     * @returns Promise resolving when subscription is complete
     * @see BLEState
     */
    subscribeToStateChange(callback: (state: BLEState) => void, emitInitial?: boolean): Subscription;
    /**
     * Open Bluetooth settings
     * @returns Promise resolving when settings are opened
     */
    openSettings(): Promise<void>;
}
