// Nitro constraint: Use numeric enums instead of string unions
export var BLEState;
(function (BLEState) {
    BLEState[BLEState["Unknown"] = 0] = "Unknown";
    BLEState[BLEState["Resetting"] = 1] = "Resetting";
    BLEState[BLEState["Unsupported"] = 2] = "Unsupported";
    BLEState[BLEState["Unauthorized"] = 3] = "Unauthorized";
    BLEState[BLEState["PoweredOff"] = 4] = "PoweredOff";
    BLEState[BLEState["PoweredOn"] = 5] = "PoweredOn";
})(BLEState || (BLEState = {}));
export var AndroidScanMode;
(function (AndroidScanMode) {
    AndroidScanMode[AndroidScanMode["LowLatency"] = 0] = "LowLatency";
    AndroidScanMode[AndroidScanMode["Balanced"] = 1] = "Balanced";
    AndroidScanMode[AndroidScanMode["LowPower"] = 2] = "LowPower";
    AndroidScanMode[AndroidScanMode["Opportunistic"] = 3] = "Opportunistic";
})(AndroidScanMode || (AndroidScanMode = {}));
