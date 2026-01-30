import Foundation
import CoreBluetooth
import iOSMcuManagerLibrary

extension Data {
    init?(hexString: String) {
        let len = hexString.count
        guard len % 2 == 0 else { return nil }

        var data = Data(capacity: len / 2)
        var index = hexString.startIndex

        for _ in 0..<(len / 2) {
            let nextIndex = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<nextIndex], radix: 16) else {
                return nil
            }
            data.append(byte)
            index = nextIndex
        }

        self = data
    }
}

public class BleNitroMcuManager {
    private var transport: McuMgrBleTransport?
    private var imageManager: ImageManager?
    private var defaultManager: DefaultManager?

    private var dfuManager: FirmwareUpgradeManager?
    private var dfuDelegate: DFUDelegate?

    private var currentState: DfuState = DfuState.idle

    private var stateCallback: ((DfuState) -> Void)?
    private var progressCallback: ((DfuProgress) -> Void)?
    private var errorCallback: ((DfuError) -> Void)?

    private unowned let bleManager: BleNitroBleManager

    public init(bleManager: BleNitroBleManager) {
        self.bleManager = bleManager
    }

    private func setState(_ state: DfuState) {
        currentState = state
        stateCallback?(state)
    }

    private func getPeripheral(deviceId: String) throws -> CBPeripheral {
        guard let peripheral = bleManager.getPeripheral(deviceId: deviceId) else {
            throw NSError(
                domain: "BleNitroMcuManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Peripheral not found for deviceId \(deviceId)"]
            )
        }
        return peripheral
    }

    private final class DFUDelegate: NSObject, FirmwareUpgradeDelegate {
        func upgradeStateDidChange(
            from previousState: FirmwareUpgradeState,
            to newState: FirmwareUpgradeState
        ) {
            // Map only high-level transitions that are stable across SDK versions.
            switch newState {
            case .none:
                onState(.idle)

            case .requestMcuMgrParameters,
                 .bootloaderInfo,
                 .eraseAppSettings,
                 .resetIntoFirmwareLoader:
                // Early / preparation phases
                onState(.connecting)

            case .upload:
                onState(.uploading)

            case .validate,
                 .test:
                onState(.validating)

            case .confirm:
                onState(.confirming)

            case .reset:
                onState(.resetting)

            case .success:
                onState(.completed)
            }
        }

        private let onState: (DfuState) -> Void
        private let onProgress: (Int) -> Void
        private let onError: (Error) -> Void

        init(
            onState: @escaping (DfuState) -> Void,
            onProgress: @escaping (Int) -> Void,
            onError: @escaping (Error) -> Void
        ) {
            self.onState = onState
            self.onProgress = onProgress
            self.onError = onError
        }

        func upgradeDidStart(controller: FirmwareUpgradeController) {
            onState(.connecting)
        }

        func uploadProgressDidChange(bytesSent: Int, imageSize: Int, timestamp: Date) {
            let percent = imageSize == 0 ? 0 : Int((Double(bytesSent) / Double(imageSize)) * 100.0)
            onProgress(percent)
        }

        func upgradeDidComplete() {
            onState(.completed)
        }

        func upgradeDidFail(inState state: FirmwareUpgradeState, with error: Error) {
            onError(error)
        }

        func upgradeDidCancel(state: FirmwareUpgradeState) {
            onState(.aborted)
        }
    }

    public func uploadImage(deviceId: String, firmwarePath: String) throws {
        let peripheral = try getPeripheral(deviceId: deviceId)

        setState(.connecting)

        transport = McuMgrBleTransport(peripheral)

        dfuDelegate = DFUDelegate(
            onState: { [weak self] state in
                self?.setState(state)
            },
            onProgress: { [weak self] percent in
                guard let self else { return }
                let progress = DfuProgress(
                    percent: Double(percent),
                    bytesSent: 0,
                    bytesTotal: 100
                )
                self.progressCallback?(progress)
            },
            onError: { [weak self] error in
                self?.setState(.error)
                self?.errorCallback?(DfuError(
                    code: -1,
                    message: error.localizedDescription
                ))
            }
        )

        guard let delegate = dfuDelegate else { return }

        dfuManager = FirmwareUpgradeManager(transport: transport!, delegate: delegate)

        let fileURL: URL
        if firmwarePath.hasPrefix("file://") {
            fileURL = URL(string: firmwarePath)!
        } else {
            fileURL = URL(fileURLWithPath: firmwarePath)
        }

        let package = try McuMgrPackage(from: fileURL)

        DispatchQueue.main.async {
            self.dfuManager?.start(package: package)
        }
    }

    public func abortUpload() throws {
        imageManager?.cancelUpload()
        setState(DfuState.aborted)
    }

    public func listImages(deviceId: String) throws -> [ImageSlot] {
        let peripheral = try getPeripheral(deviceId: deviceId)

        transport = McuMgrBleTransport(peripheral)
        imageManager = ImageManager(transport: transport!)

        var result: [ImageSlot] = []
        let semaphore = DispatchSemaphore(value: 0)

        imageManager?.list { response, error in
            defer { semaphore.signal() }

            guard let images = response?.images else { return }

            result = images.map {
                ImageSlot(
                    slot: Double(Int($0.slot)),
                    version: $0.version ?? "",
                    hash: Data($0.hash).map { String(format: "%02hhx", $0) }.joined(),
                    bootable: $0.bootable,
                    pending: $0.pending,
                    confirmed: $0.confirmed,
                    active: $0.active
                )
            }
        }

        semaphore.wait()
        return result
    }

    public func confirmImage(deviceId: String, hash: String) throws {
        let peripheral = try getPeripheral(deviceId: deviceId)

        transport = McuMgrBleTransport(peripheral)
        imageManager = ImageManager(transport: transport!)

        setState(DfuState.confirming)

        guard let data = Data(hexString: hash) else {
            throw NSError(
                domain: "BleNitroMcuManager",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Invalid image hash"]
            )
        }

        let hashBytes = [UInt8](data)

        imageManager?.confirm(hash: hashBytes) { [weak self] _, error in
            if let error {
                self?.setState(DfuState.error)
                self?.errorCallback?(DfuError(
                    code: -1,
                    message: error.localizedDescription
                ))
            }
        }
    }

    public func resetDevice(deviceId: String) throws {
        let peripheral = try getPeripheral(deviceId: deviceId)

        transport = McuMgrBleTransport(peripheral)
        defaultManager = DefaultManager(transport: transport!)

        setState(DfuState.resetting)

        defaultManager?.reset { [weak self] _, error in
            if let error {
                self?.setState(DfuState.error)
                self?.errorCallback?(DfuError(
                    code: -1,
                    message: error.localizedDescription
                ))
            }
        }
    }

    public func getState() throws -> DfuState {
        return currentState
    }

    public func onStateChanged(callback: @escaping (DfuState) -> Void) throws {
        stateCallback = callback
    }

    public func onProgress(callback: @escaping (DfuProgress) -> Void) throws {
        progressCallback = callback
    }

    public func onError(callback: @escaping (DfuError) -> Void) throws {
        errorCallback = callback
    }
}
