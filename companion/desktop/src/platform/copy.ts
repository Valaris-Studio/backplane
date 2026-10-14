// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { currentPlatform, type PlatformOs } from "./platform";

/** The words that name the computer, its file manager, tray, shortcuts and credential store. */
export interface PlatformCopy {
  /** "this Mac", mid-sentence. */
  thisDevice: string;
  /** "This Mac", starting a sentence or as a heading. */
  ThisDevice: string;
  /** Where the tray icon lives: "in the menu bar shows its status". */
  trayLocation: string;
  /** Welcome's "Pause any time" promise. */
  pauseAnyTime: string;
  /** Done's "Pause" hint: how to reach the pause control. */
  pauseHowTo: string;
  showInFileManager: string;
  fileManagerFailed: string;
  copyShortcut: string;
  quitCodexStep: string;
  /** Why pairing couldn't store the device's sign-in (daemon code secure_credential_store_unavailable). */
  credentialStore: { title: string; body: string };
  /** Where the sign-in is deleted from on disconnect: "…deleted from the keychain." */
  credentialStoreName: string;
  /** The app runs from outside its trusted install location (capture refused). */
  installFirst: string;
  installFirstBeforeRemoval: string;
  /** What's left once Remove Companion finished: the app itself. */
  deleteAppStep: string;
  loginItemsRefused: string;
}

const MACOS: PlatformCopy = {
  thisDevice: "this Mac",
  ThisDevice: "This Mac",
  trayLocation: "menu bar",
  pauseAnyTime: "From the menu bar, in one click.",
  pauseHowTo: "Click the icon, then the pause button. Or right-click it.",
  showInFileManager: "Show in Finder",
  fileManagerFailed: "Finder couldn’t show the file.",
  copyShortcut: "⌘C",
  quitCodexStep: "Quit Codex with ⌘Q.",
  credentialStore: {
    title: "Your keychain isn’t available",
    body: "Companion keeps this Mac’s sign-in in the macOS keychain, and it’s locked or unavailable right now. Unlock your Mac (not over SSH) and try again. Nothing was stored.",
  },
  credentialStoreName: "the keychain",
  installFirst: "Move Backplane Companion to your Applications folder, then try again.",
  installFirstBeforeRemoval: "Move Backplane Companion to Applications, then try again. Nothing was removed.",
  deleteAppStep: "Quit, then move the app to the Trash.",
  loginItemsRefused: "macOS didn’t let Companion change Open at login. Check Login Items in System Settings.",
};

const WINDOWS: PlatformCopy = {
  thisDevice: "this PC",
  ThisDevice: "This PC",
  trayLocation: "notification area",
  pauseAnyTime: "From the notification area, in one click.",
  pauseHowTo: "Click the icon, then the pause button. Or right-click it.",
  showInFileManager: "Show in Explorer",
  fileManagerFailed: "File Explorer couldn’t show the file.",
  copyShortcut: "Ctrl+C",
  quitCodexStep: "Quit Codex completely.",
  credentialStore: {
    title: "Credential Manager isn’t available",
    body: "Companion keeps this PC’s sign-in in Windows Credential Manager, and it can’t be reached right now. Sign in to Windows as yourself (not over a remote session) and try again. Nothing was stored.",
  },
  credentialStoreName: "Credential Manager",
  installFirst: "Install Backplane Companion with its installer, then try again.",
  installFirstBeforeRemoval: "Open Backplane Companion from where its installer put it, then try again. Nothing was removed.",
  deleteAppStep: "Quit, then uninstall the app from Installed apps in Settings.",
  loginItemsRefused: "Windows didn’t let Companion change Open at login. Check Startup apps in Settings.",
};

const LINUX: PlatformCopy = {
  thisDevice: "this computer",
  ThisDevice: "This computer",
  trayLocation: "system tray",
  pauseAnyTime: "From the tray icon’s menu, or the pause button in this window.",
  pauseHowTo: "Choose Pause capture in the tray icon’s menu, or use the pause button at the top of this window.",
  showInFileManager: "Show in Files",
  fileManagerFailed: "The file manager couldn’t show the file.",
  copyShortcut: "Ctrl+C",
  quitCodexStep: "Quit Codex completely.",
  credentialStore: {
    title: "Your keyring isn’t available",
    body: "Companion keeps this computer’s sign-in in your keyring through the Secret Service, and it’s locked or no keyring service is running. Unlock your keyring (for example GNOME Keyring or KWallet) and try again. Nothing was stored.",
  },
  credentialStoreName: "your keyring",
  installFirst: "Install Backplane Companion from its package, then try again.",
  installFirstBeforeRemoval: "Open Backplane Companion from its installed package, then try again. Nothing was removed.",
  deleteAppStep: "Quit, then uninstall the app with your package manager.",
  loginItemsRefused: "Companion couldn’t change Open at login. Check your desktop’s autostart settings.",
};

const UNKNOWN: PlatformCopy = {
  thisDevice: "this computer",
  ThisDevice: "This computer",
  trayLocation: "system tray",
  pauseAnyTime: "From the tray icon’s menu, or the pause button in this window.",
  pauseHowTo: "Choose Pause capture in the tray icon’s menu, or use the pause button at the top of this window.",
  showInFileManager: "Show in folder",
  fileManagerFailed: "The file manager couldn’t show the file.",
  copyShortcut: "Ctrl+C",
  quitCodexStep: "Quit Codex completely.",
  credentialStore: {
    title: "Your credential store isn’t available",
    body: "Companion keeps this computer’s sign-in in the system’s credential store, and it’s locked or unavailable right now. Unlock it and try again. Nothing was stored.",
  },
  credentialStoreName: "the system’s credential store",
  installFirst: "Install Backplane Companion first, then try again.",
  installFirstBeforeRemoval: "Open the installed Backplane Companion, then try again. Nothing was removed.",
  deleteAppStep: "Quit, then uninstall the app.",
  loginItemsRefused: "Companion couldn’t change Open at login. Try again.",
};

const COPY_FOR: Record<PlatformOs, PlatformCopy> = { macos: MACOS, windows: WINDOWS, linux: LINUX, unknown: UNKNOWN };

/** Read at render time, never captured in a module constant: the platform is only known once main.tsx has loaded it. */
export function platformCopy(os: PlatformOs = currentPlatform().os): PlatformCopy {
  return COPY_FOR[os];
}
