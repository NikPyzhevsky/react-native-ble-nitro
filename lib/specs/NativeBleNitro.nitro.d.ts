import { HybridObject } from 'react-native-nitro-modules';
export type BLEValue = ArrayBuffer;
export declare enum BLEState {
    Unknown = 0,
    Resetting = 1,
    Unsupported = 2,
    Unauthorized = 3,
    PoweredOff = 4,
    PoweredOn = 5
}
export interface ManufacturerDataEntry {
    id: string;
    data: BLEValue;
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
export declare enum AndroidScanMode {
    LowLatency = 0,
    Balanced = 1,
    LowPower = 2,
    Opportunistic = 3
}
export interface ScanFilter {
    serviceUUIDs: string[];
    rssiThreshold: number;
    allowDuplicates: boolean;
    androidScanMode: AndroidScanMode;
}
export type ScanCallback = (device: BLEDevice | null, error: string | null) => void;
export type DevicesCallback = (devices: BLEDevice[]) => void;
export type ConnectionCallback = (success: boolean, deviceId: string, error: string) => void;
export type DisconnectionEventCallback = (deviceId: string, interrupted: boolean, error: string) => void;
export type OperationCallback = (success: boolean, error: string) => void;
export type CharacteristicCallback = (characteristicId: string, data: BLEValue) => void;
export type StateCallback = (state: BLEState) => void;
export type BooleanCallback = (result: boolean) => void;
export type StringArrayCallback = (result: string[]) => void;
export type ReadCharacteristicCallback = (success: boolean, data: BLEValue, error: string) => void;
export type WriteCharacteristicCallback = (success: boolean, responseData: BLEValue, error: string) => void;
export type ReadRSSICallback = (success: boolean, rssi: number, error: string) => void;
export type RestoreCallback = (restoredPeripherals: BLEDevice[]) => void;
export type OperationResult = {
    success: boolean;
    error?: string;
};
/**
 * Native BLE Nitro Module Specification
 * Defines the interface between TypeScript and native implementations
 */
export interface NativeBleNitro extends HybridObject<{
    ios: 'swift';
    android: 'kotlin';
}> {
    setRestoreStateCallback(callback: RestoreCallback): void;
    startScan(filter: ScanFilter, callback: ScanCallback): void;
    stopScan(): boolean;
    isScanning(): boolean;
    getConnectedDevices(services: string[]): BLEDevice[];
    getBondedDevices(): BLEDevice[];
    connect(deviceId: string, callback: ConnectionCallback, disconnectCallback?: DisconnectionEventCallback): void;
    createBond(deviceId: string, callback: OperationCallback): void;
    disconnect(deviceId: string, callback: OperationCallback): void;
    isConnected(deviceId: string): boolean;
    requestMTU(deviceId: string, mtu: number): number;
    readRSSI(deviceId: string, callback: ReadRSSICallback): void;
    discoverServices(deviceId: string, callback: OperationCallback): void;
    getServices(deviceId: string): string[];
    getCharacteristics(deviceId: string, serviceId: string): string[];
    readCharacteristic(deviceId: string, serviceId: string, characteristicId: string, callback: ReadCharacteristicCallback): void;
    writeCharacteristic(deviceId: string, serviceId: string, characteristicId: string, data: BLEValue, withResponse: boolean, callback: WriteCharacteristicCallback): void;
    subscribeToCharacteristic(deviceId: string, serviceId: string, characteristicId: string, updateCallback: CharacteristicCallback, resultCallback: OperationCallback): void;
    unsubscribeFromCharacteristic(deviceId: string, serviceId: string, characteristicId: string, callback: OperationCallback): void;
    requestBluetoothEnable(callback: OperationCallback): void;
    state(): BLEState;
    subscribeToStateChange(stateCallback: StateCallback): OperationResult;
    unsubscribeFromStateChange(): OperationResult;
    openSettings(): Promise<void>;
}
