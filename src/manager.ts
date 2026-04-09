import BleNitroNative, {DfuError, DfuProgress, DfuState} from './specs/NativeBleNitro';
import {
  ScanFilter as NativeScanFilter,
  BLEDevice as NativeBLEDevice,
  BLEState as NativeBLEState,
  ScanCallback as NativeScanCallback,
  AndroidScanMode as NativeAndroidScanMode,
} from './specs/NativeBleNitro';

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
export type ConnectionCallback = (
  success: boolean,
  deviceId: string,
  error: string
) => void;
export type DisconnectEventCallback = (
  deviceId: string,
  interrupted: boolean,
  error: string
) => void;
export type OperationCallback = (success: boolean, error: string) => void;
export type CharacteristicUpdateCallback = (
  characteristicId: string,
  data: ByteArray
) => void;

export type Subscription = {
  remove: () => void;
};

export enum BLEState {
  Unknown = 'Unknown',
  Resetting = 'Resetting',
  Unsupported = 'Unsupported',
  Unauthorized = 'Unauthorized',
  PoweredOff = 'PoweredOff',
  PoweredOn = 'PoweredOn',
};

export enum AndroidScanMode {
  LowLatency = 'LowLatency',
  Balanced = 'Balanced',
  LowPower = 'LowPower',
  Opportunistic = 'Opportunistic',
}

export type BleNitroManagerOptions = {
  onRestoredState?: RestoreStateCallback;
};

type SharedCharacteristicSubscription = {
  deviceId: string;
  serviceId: string;
  characteristicId: string;
  listeners: Map<number, SharedCharacteristicListener>;
  nativeSubscribed: boolean;
  nativeSubscribePending: boolean;
  nativeUnsubscribePending: boolean;
};

type SharedCharacteristicListener = {
  callback: CharacteristicUpdateCallback;
  source?: string;
};

export function mapNativeBLEStateToBLEState(nativeState: NativeBLEState): BLEState {
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

export function mapAndroidScanModeToNativeAndroidScanMode(scanMode: AndroidScanMode): NativeAndroidScanMode {
  const map = {
    LowLatency: NativeAndroidScanMode.LowLatency,
    Balanced: NativeAndroidScanMode.Balanced,
    LowPower: NativeAndroidScanMode.LowPower,
    Opportunistic: NativeAndroidScanMode.Opportunistic,
  }
  return map[scanMode];
}

export function convertNativeBleDeviceToBleDevice(nativeBleDevice: NativeBLEDevice): BLEDevice {
  return {
    ...nativeBleDevice,
    serviceUUIDs: BleNitroManager.normalizeGattUUIDs(nativeBleDevice.serviceUUIDs),
    manufacturerData: {
      companyIdentifiers: nativeBleDevice.manufacturerData.companyIdentifiers.map(entry => ({
        id: entry.id,
        data: arrayBufferToByteArray(entry.data)
      }))
    }
  }
}

export function arrayBufferToByteArray(buffer: ArrayBuffer): ByteArray {
  return Array.from(new Uint8Array(buffer));
}

export function byteArrayToArrayBuffer(data: ByteArray): ArrayBuffer {
  return new Uint8Array(data).buffer;
}

function logSharedSubscription(message: string) {
  void message;
}

export class BleNitroManager {
  private _isScanning: boolean = false;
  private _connectedDevices: { [deviceId: string]: boolean } = {};
  private _sharedCharacteristicSubscriptions: {
    [subscriptionKey: string]: SharedCharacteristicSubscription;
  } = {};
  private _nextSubscriptionListenerId = 1;

  private _restoredStateCallback: RestoreStateCallback | null = null;
  private _restoredState: BLEDevice[] | null = null;

  constructor(options?: BleNitroManagerOptions) {
    this._restoredStateCallback = options?.onRestoredState || null;
    BleNitroNative.setRestoreStateCallback((peripherals: NativeBLEDevice[]) => this.onNativeRestoreStateCallback(peripherals));
  }

  private onNativeRestoreStateCallback(peripherals: NativeBLEDevice[]) {
    const bleDevices = peripherals.map((peripheral) => convertNativeBleDeviceToBleDevice(peripheral));
    if (this._restoredStateCallback) {
      this._restoredStateCallback(bleDevices);
    } else {
      this._restoredState = bleDevices;
    }
  }

  public onRestoredState(callback: RestoreStateCallback) {
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
  public static normalizeGattUUID(uuid: string): string {
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

  public static normalizeGattUUIDs(uuids: string[]): string[] {
    return uuids.map((uuid) => BleNitroManager.normalizeGattUUID(uuid));
  }

  private static createCharacteristicSubscriptionKey(
    deviceId: string,
    serviceId: string,
    characteristicId: string
  ): string {
    return [
      deviceId,
      BleNitroManager.normalizeGattUUID(serviceId),
      BleNitroManager.normalizeGattUUID(characteristicId),
    ].join('|');
  }

  private describeListenerSources(subscription: SharedCharacteristicSubscription): string {
    const sources = Array.from(subscription.listeners.values()).map(
      (listener) => listener.source ?? 'unknown'
    );

    return sources.length > 0 ? sources.join(',') : '-';
  }

  private ensureCharacteristicSubscription(
    subscriptionKey: string,
    subscription: SharedCharacteristicSubscription
  ): void {
    if (
      subscription.nativeSubscribed ||
      subscription.nativeSubscribePending ||
      subscription.nativeUnsubscribePending
    ) {
      logSharedSubscription(
        `skip ensure key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)} nativeSubscribed=${subscription.nativeSubscribed} subscribePending=${subscription.nativeSubscribePending} unsubscribePending=${subscription.nativeUnsubscribePending}`
      );
      return;
    }

    logSharedSubscription(
      `native subscribe start key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`
    );
    subscription.nativeSubscribePending = true;

    BleNitroNative.subscribeToCharacteristic(
      subscription.deviceId,
      subscription.serviceId,
      subscription.characteristicId,
      (charId: string, data: ArrayBuffer) => {
        const currentSubscription = this._sharedCharacteristicSubscriptions[subscriptionKey];

        if (!currentSubscription) {
          return;
        }

        const byteArray = arrayBufferToByteArray(data);
        currentSubscription.listeners.forEach((listener) => {
          listener.callback(charId, byteArray);
        });
      },
      (success, error) => {
        const currentSubscription = this._sharedCharacteristicSubscriptions[subscriptionKey];

        if (!currentSubscription) {
          return;
        }

        currentSubscription.nativeSubscribePending = false;

        if (!success) {
          logSharedSubscription(
            `native subscribe failed key=${subscriptionKey} listeners=${currentSubscription.listeners.size} sources=${this.describeListenerSources(currentSubscription)} error=${error}`
          );
          console.warn(`[BleNitro] subscribeToCharacteristic failed: ${error}`);

          if (currentSubscription.listeners.size === 0) {
            delete this._sharedCharacteristicSubscriptions[subscriptionKey];
          }
          return;
        }

        currentSubscription.nativeSubscribed = true;
        logSharedSubscription(
          `native subscribe success key=${subscriptionKey} listeners=${currentSubscription.listeners.size} sources=${this.describeListenerSources(currentSubscription)}`
        );

        if (currentSubscription.listeners.size === 0) {
          this.teardownCharacteristicSubscription(subscriptionKey, currentSubscription);
        }
      }
    );
  }

  private teardownCharacteristicSubscription(
    subscriptionKey: string,
    subscription: SharedCharacteristicSubscription
  ): void {
    if (subscription.nativeUnsubscribePending) {
      logSharedSubscription(
        `skip native unsubscribe pending key=${subscriptionKey} sources=${this.describeListenerSources(subscription)}`
      );
      return;
    }

    if (!subscription.nativeSubscribed) {
      logSharedSubscription(
        `skip native unsubscribe because not subscribed key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)} subscribePending=${subscription.nativeSubscribePending}`
      );
      if (!subscription.nativeSubscribePending && subscription.listeners.size === 0) {
        delete this._sharedCharacteristicSubscriptions[subscriptionKey];
      }
      return;
    }

    logSharedSubscription(
      `native unsubscribe start key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`
    );
    subscription.nativeUnsubscribePending = true;

    BleNitroNative.unsubscribeFromCharacteristic(
      subscription.deviceId,
      subscription.serviceId,
      subscription.characteristicId,
      (success: boolean, error: string) => {
        const currentSubscription = this._sharedCharacteristicSubscriptions[subscriptionKey];

        if (!currentSubscription) {
          return;
        }

        currentSubscription.nativeUnsubscribePending = false;
        currentSubscription.nativeSubscribed = false;
        logSharedSubscription(
          `native unsubscribe done key=${subscriptionKey} listeners=${currentSubscription.listeners.size} sources=${this.describeListenerSources(currentSubscription)} success=${success}`
        );

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
      }
    );
  }

  private removeCharacteristicListener(subscriptionKey: string, listenerId: number): void {
    const subscription = this._sharedCharacteristicSubscriptions[subscriptionKey];

    if (!subscription) {
      return;
    }

    const listener = subscription.listeners.get(listenerId);
    subscription.listeners.delete(listenerId);
    logSharedSubscription(
      `listener removed key=${subscriptionKey} listenerId=${listenerId} source=${listener?.source ?? 'unknown'} remaining=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`
    );

    if (subscription.listeners.size > 0) {
      logSharedSubscription(
        `keep native subscription key=${subscriptionKey} remaining=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`
      );
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

  private clearCharacteristicSubscriptionsForDevice(deviceId: string): void {
    Object.keys(this._sharedCharacteristicSubscriptions).forEach((subscriptionKey) => {
      const subscription = this._sharedCharacteristicSubscriptions[subscriptionKey];

      if (subscription?.deviceId === deviceId) {
        logSharedSubscription(
          `clear device subscriptions deviceId=${deviceId} key=${subscriptionKey} listeners=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`
        );
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
  public startScan(
    filter: ScanFilter = {},
    callback: ScanCallback,
    onError?: (error: string) => void,
  ): void {
    if (this._isScanning) {
      return;
    }

    // Create native scan filter with defaults
    const nativeFilter: NativeScanFilter = {
      serviceUUIDs: filter.serviceUUIDs || [],
      rssiThreshold: filter.rssiThreshold ?? -100,
      allowDuplicates: filter.allowDuplicates ?? false,
      androidScanMode: mapAndroidScanModeToNativeAndroidScanMode(filter.androidScanMode ?? AndroidScanMode.Balanced),
    };

    // Create callback wrapper
    const scanCallback: NativeScanCallback = (device: NativeBLEDevice | null, error: string | null) => {
      if (error && !device) {
        this._isScanning = false;
        onError?.(error);
        return;
      }
      device = device!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
      // Convert manufacturer data to Uint8Arrays
      const convertedDevice: BLEDevice = convertNativeBleDeviceToBleDevice(device);
      callback(convertedDevice);
    };

    // Start scan
    BleNitroNative.startScan(nativeFilter, scanCallback);
    this._isScanning = true;
  }

  /**
   * Stop scanning for Bluetooth devices
   * @returns Promise resolving to success state
   */
  public stopScan(): void {
    if (!this._isScanning) {
      return;
    }

    BleNitroNative.stopScan();
    this._isScanning = false;
  }

  /**
   * Check if currently scanning for devices
   * @returns Promise resolving to scanning state
   */
  public isScanning(): boolean {
    this._isScanning = BleNitroNative.isScanning();
    return this._isScanning;
  }

  /**
   * Get all currently connected devices
   * @param services Optional list of service UUIDs to filter by
   * @returns Array of connected devices
   */
  public getConnectedDevices(services?: string[]): BLEDevice[] {
    const devices = BleNitroNative.getConnectedDevices(services || []);
    // Normalize service UUIDs - manufacturer data already comes as ArrayBuffers
    return devices.map(device => convertNativeBleDeviceToBleDevice(device));
  }

  /**
   * Get OS-bonded (paired) devices (Android only)
   * @returns Array of bonded devices
   */
  public getBondedDevices(): BLEDevice[] {
    const devices = BleNitroNative.getBondedDevices();
    return devices.map(device => convertNativeBleDeviceToBleDevice(device));
  }

  /**
   * Connect to a Bluetooth device
   * @param deviceId ID of the device to connect to
   * @param onDisconnect Optional callback for disconnect events
   * @returns Promise resolving when connected
   */
  public connect(
    deviceId: string,
    onDisconnect?: DisconnectEventCallback
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Check if already connected
      if (this._connectedDevices[deviceId]) {
        resolve(deviceId);
        return;
      }

      BleNitroNative.connect(
        deviceId,
        (success: boolean, connectedDeviceId: string, error: string) => {
          if (success) {
            this._connectedDevices[deviceId] = true;
            resolve(connectedDeviceId);
          } else {
            reject(new Error(error));
          }
        },
        onDisconnect ? (deviceId: string, interrupted: boolean, error: string) => {
          // Remove from connected devices when disconnected
          delete this._connectedDevices[deviceId];
          this.clearCharacteristicSubscriptionsForDevice(deviceId);
          onDisconnect(deviceId, interrupted, error);
        } : undefined
      );
    });
  }

  /**
   * Initiate bonding (pairing) with a device (Android only)
   * @param deviceId ID of the device to bond with
   * @returns Promise resolving when bonding is initiated/completed successfully
   */
  public createBond(deviceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      BleNitroNative.createBond(
        deviceId,
        (success: boolean, error: string) => {
          if (success) {
            resolve();
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  }

  /**
   * Disconnect from a Bluetooth device
   * @param deviceId ID of the device to disconnect from
   * @returns Promise resolving when disconnected
   */
  public disconnect(deviceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if already disconnected
      if (!this._connectedDevices[deviceId]) {
        this.clearCharacteristicSubscriptionsForDevice(deviceId);
        resolve();
        return;
      }

      BleNitroNative.disconnect(
        deviceId,
        (success: boolean, error: string) => {
          if (success) {
            delete this._connectedDevices[deviceId];
            this.clearCharacteristicSubscriptionsForDevice(deviceId);
            resolve();
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  }

  /**
   * Check if connected to a device
   * @param deviceId ID of the device to check
   * @returns Promise resolving to connection state
   */
  public isConnected(deviceId: string): boolean {
    return BleNitroNative.isConnected(deviceId);
  }

  /**
   * Request a new MTU size
   * @param deviceId ID of the device
   * @param mtu New MTU size, min is 23, max is 517
   * @returns On Android: new MTU size; on iOS: current MTU size as it is handled by iOS itself; on error: -1
   */
  public requestMTU(deviceId: string, mtu: number): number {
    mtu = parseInt(mtu.toString(), 10);
    const deviceMtu = BleNitroNative.requestMTU(deviceId, mtu);
    return deviceMtu;
  }

  /**
   * Read RSSI for a connected device
   * @param deviceId ID of the device
   * @returns Promise resolving to RSSI value
   */
  public readRSSI(deviceId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // Check if connected first
      if (!this._connectedDevices[deviceId]) {
        reject(new Error('Device not connected'));
        return;
      }

      BleNitroNative.readRSSI(
        deviceId,
        (success: boolean, rssi: number, error: string) => {
          if (success) {
            resolve(rssi);
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  }

  /**
   * Discover services for a connected device
   * @param deviceId ID of the device
   * @returns Promise resolving when services are discovered
   */
  public discoverServices(deviceId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Check if connected first
      if (!this._connectedDevices[deviceId]) {
        reject(new Error('Device not connected'));
        return;
      }

      BleNitroNative.discoverServices(
        deviceId,
        (success: boolean, error: string) => {
          if (success) {
            resolve(true);
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  }

  /**
   * Get services for a connected device
   * @param deviceId ID of the device
   * @returns Promise resolving to array of service UUIDs
   */
  public getServices(deviceId: string): Promise<string[]> {
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
      const services = BleNitroNative.getServices(deviceId);
      resolve(BleNitroManager.normalizeGattUUIDs(services));
    });
  }

  /**
   * Get characteristics for a service
   * @param deviceId ID of the device
   * @param serviceId ID of the service
   * @returns Promise resolving to array of characteristic UUIDs
   */
  public getCharacteristics(
    deviceId: string,
    serviceId: string
  ): string[] {
    if (!this._connectedDevices[deviceId]) {
      throw new Error('Device not connected');
    }

    const characteristics = BleNitroNative.getCharacteristics(
      deviceId,
      BleNitroManager.normalizeGattUUID(serviceId),
    );
    return BleNitroManager.normalizeGattUUIDs(characteristics);
  }

  /**
   * Read a characteristic value
   * @param deviceId ID of the device
   * @param serviceId ID of the service
   * @param characteristicId ID of the characteristic
   * @returns Promise resolving to the characteristic data as ArrayBuffer
   */
  public readCharacteristic(
    deviceId: string,
    serviceId: string,
    characteristicId: string
  ): Promise<ByteArray> {
    return new Promise((resolve, reject) => {
      // Check if connected first
      if (!this._connectedDevices[deviceId]) {
        reject(new Error('Device not connected'));
        return;
      }

      BleNitroNative.readCharacteristic(
        deviceId,
        BleNitroManager.normalizeGattUUID(serviceId),
        BleNitroManager.normalizeGattUUID(characteristicId),
        (success: boolean, data: ArrayBuffer, error: string) => {
          if (success) {
            resolve(arrayBufferToByteArray(data));
          } else {
            reject(new Error(error));
          }
        }
      );
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
  public writeCharacteristic(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    data: ByteArray,
    withResponse: boolean = true
  ): Promise<ByteArray> {
    return new Promise((resolve, reject) => {
      // Check if connected first
      if (!this._connectedDevices[deviceId]) {
        reject(new Error('Device not connected'));
        return;
      }

      BleNitroNative.writeCharacteristic(
        deviceId,
        BleNitroManager.normalizeGattUUID(serviceId),
        BleNitroManager.normalizeGattUUID(characteristicId),
        byteArrayToArrayBuffer(data),
        withResponse,
        (success: boolean, responseData: ArrayBuffer, error: string) => {
          if (success) {
            // Convert ArrayBuffer response to ByteArray
            const responseByteArray = arrayBufferToByteArray(responseData);
            resolve(responseByteArray);
          } else {
            reject(new Error(error));
          }
        }
      );
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
  public subscribeToCharacteristic(
    deviceId: string,
    serviceId: string,
    characteristicId: string,
    callback: CharacteristicUpdateCallback,
    debugSource?: string
  ): Subscription {
    // Check if connected first
    if (!this._connectedDevices[deviceId]) {
      throw new Error('Device not connected');
    }

    const normalizedServiceId = BleNitroManager.normalizeGattUUID(serviceId);
    const normalizedCharacteristicId = BleNitroManager.normalizeGattUUID(characteristicId);
    const subscriptionKey = BleNitroManager.createCharacteristicSubscriptionKey(
      deviceId,
      normalizedServiceId,
      normalizedCharacteristicId
    );

    let subscription = this._sharedCharacteristicSubscriptions[subscriptionKey];

    if (!subscription) {
      subscription = {
        deviceId,
        serviceId: normalizedServiceId,
        characteristicId: normalizedCharacteristicId,
        listeners: new Map<number, SharedCharacteristicListener>(),
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
    logSharedSubscription(
      `listener added key=${subscriptionKey} listenerId=${listenerId} source=${debugSource ?? 'unknown'} total=${subscription.listeners.size} sources=${this.describeListenerSources(subscription)}`
    );
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
  public unsubscribeFromCharacteristic(
    deviceId: string,
    serviceId: string,
    characteristicId: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if connected first
      if (!this._connectedDevices[deviceId]) {
        reject(new Error('Device not connected'));
        return;
      }

      BleNitroNative.unsubscribeFromCharacteristic(
        deviceId,
        BleNitroManager.normalizeGattUUID(serviceId),
        BleNitroManager.normalizeGattUUID(characteristicId),
        (success: boolean, error: string) => {
          if (success) {
            resolve();
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  }

  /**
   * Check if Bluetooth is enabled
   * @returns Promise resolving to Bluetooth state
   */
  public isBluetoothEnabled(): boolean {
    return this.state() === BLEState.PoweredOn;
  }

  /**
   * Request to enable Bluetooth (Android only)
   * @returns Promise resolving when Bluetooth is enabled
   */
  public requestBluetoothEnable(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      BleNitroNative.requestBluetoothEnable(
        (success: boolean, error: string) => {
          if (success) {
            resolve(true);
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  }

  /**
   * Get the current Bluetooth state
   * @returns Promise resolving to Bluetooth state
   * @see BLEState
   */
  public state(): BLEState {
    return mapNativeBLEStateToBLEState(BleNitroNative.state());
  }

  /**
   * Subscribe to Bluetooth state changes
   * @param callback Callback function called when state changes
   * @param emitInitial Whether to emit initial state callback
   * @returns Promise resolving when subscription is complete
   * @see BLEState
   */
  public subscribeToStateChange(callback: (state: BLEState) => void, emitInitial = false): Subscription {
      if (emitInitial) {
        const state = this.state();
        callback(state);
      }

      BleNitroNative.subscribeToStateChange((nativeState: NativeBLEState) => {
        callback(mapNativeBLEStateToBLEState(nativeState));
      });

      return {
        remove: () => {
          BleNitroNative.unsubscribeFromStateChange();
        },
      };
  }

    /**
     * Open Bluetooth settings
     * @returns Promise resolving when settings are opened
     */
    public openSettings(): Promise<void> {
        return BleNitroNative.openSettings();
    }

    /**
     * Open Bluetooth settings
     * @returns Promise resolving when settings are opened
     */
    public startBackgroundTask(callback: ()=> void, time: number, onClose?: ()=> void): void {
        return BleNitroNative.startBackgroundTask(callback, time, onClose ?? (() => {}));
    }

    public stopBackgroundTask(): void {
        return BleNitroNative.stopBackgroundTask();
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
    public uploadMcuImage(deviceId: string, firmwarePath: string): void {
        BleNitroNative.uploadMcuImage(deviceId, firmwarePath);
    }

    /** Abort current DFU upload (if any). */
    public abortMcuUpload(): void {
        BleNitroNative.abortMcuUpload();
    }

    /** Read MCUboot image slots. */
    public listMcuImages(deviceId: string) {
        return BleNitroNative.listMcuImages(deviceId);
    }

    /** Mark image in slot as confirmed. */
    public confirmMcuImage(deviceId: string, hash: string): void {
        BleNitroNative.confirmMcuImage(deviceId, hash);
    }

    /** Reset device after upload / confirm. */
    public resetMcuDevice(deviceId: string): void {
        BleNitroNative.resetMcuDevice(deviceId);
    }

    /** Get current DFU state. */
    public getMcuState(): DfuState {
        return BleNitroNative.getMcuState() as unknown as DfuState;
    }

    /** Subscribe to DFU state changes. */
    public onMcuStateChanged(callback: (state: DfuState) => void): void {
        BleNitroNative.onMcuStateChanged((state: DfuState) => {
            callback(state);
        });
    }

    /** Subscribe to DFU progress updates. */
    public onMcuProgress(callback: (progress: DfuProgress) => void): void {
        BleNitroNative.onMcuProgress((progress: DfuProgress) => {
            callback(progress);
        });
    }

    /** Subscribe to DFU errors. */
    public onMcuError(callback: (error: DfuError) => void): void {
        BleNitroNative.onMcuError((error: DfuError) => {
            callback(error);
        });
    }
}
