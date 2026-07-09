/**
 * Device authentication (biometric / PIN) via expo-local-authentication. Used to gate the app on
 * launch and before sensitive actions. Falls back to the device passcode where biometrics aren't
 * enrolled; if the device has no lock method at all, the app can't be locked (handled by callers).
 */
import * as LocalAuthentication from 'expo-local-authentication';

/** True if the device can authenticate the user (biometric or enrolled passcode). */
export async function canUseBiometrics(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

/** Prompt the user to authenticate. Resolves true on success. */
export async function authenticate(reason = 'Unlock Prova'): Promise<boolean> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      // Allow the device PIN/passcode as a fallback to biometrics.
      disableDeviceFallback: false,
    });
    return res.success;
  } catch {
    return false;
  }
}
