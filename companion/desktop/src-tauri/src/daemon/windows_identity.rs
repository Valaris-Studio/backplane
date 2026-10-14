// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Who this process runs as and who owns the control pipe, as SID strings,
//! so both can be compared with the SID in the pipe's name.

use std::io;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenProcessToken and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}

pub fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle; `token` is written on success.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    let mut needed = 0u32;
    // SAFETY: a null buffer of length 0 only asks for the required size.
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64 words keep the TOKEN_USER (which holds a pointer) aligned.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: the buffer holds at least `needed` bytes.
    let filled = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if filled == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points into it.
    unsafe {
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        sid_to_string(user.User.Sid)
    }
}

/// The owner recorded on the pipe object. The daemon makes the user the
/// owner explicitly; another user cannot name someone else as owner of a
/// pipe they create, so this tells a squatter apart without trusting a PID.
pub fn pipe_owner_sid(pipe: HANDLE) -> io::Result<String> {
    let mut owner: PSID = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: the out-pointers are valid; `owner` points into `descriptor`.
    let status = unsafe {
        GetSecurityInfo(
            pipe,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // SAFETY: `owner` stays valid until `descriptor` is freed below.
    let sid = unsafe { sid_to_string(owner) };
    // SAFETY: GetSecurityInfo allocated the descriptor with LocalAlloc.
    unsafe { LocalFree(descriptor) };
    sid
}

/// # Safety
/// `sid` must point to a valid SID.
unsafe fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut wide = null_mut();
    if ConvertSidToStringSidW(sid, &mut wide) == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = (0..).take_while(|&index| *wide.add(index) != 0).count();
    let text = String::from_utf16(std::slice::from_raw_parts(wide, length))
        .map_err(|_| io::Error::other("SID string is not UTF-16"));
    LocalFree(wide.cast());
    text
}
