use std::ffi::OsStr;
use std::process::Command;

#[cfg(not(windows))]
pub fn command<S: AsRef<OsStr>>(program: S) -> Command {
    Command::new(program)
}

#[cfg(windows)]
pub fn command<S: AsRef<OsStr>>(program: S) -> Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}
