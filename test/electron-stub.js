export const shell = { openExternal: async () => {} , openPath: async () => ''}
export class BrowserWindow {}
export const app = { getPath: () => process.env.TEST_DATA, getVersion: () => '0' }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
export const nativeTheme = {}
