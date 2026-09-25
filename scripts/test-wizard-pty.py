#!/usr/bin/env python3
"""Drive the real wizard in a disposable PTY. No keys leave this process."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import sys
import time
import termios
import struct

mode, *command = sys.argv[1:]
secret = "canary-key-NEVER-DISPLAY-123"
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 100, 0, 0))
    os.environ["TERM"] = "xterm-256color"
    os.environ.pop("CI", None)
    os.environ.pop("ARELAY_NO_TUI", None)
    if "NO_COLOR" in os.environ:
        os.environ.pop("FORCE_COLOR", None)
    else:
        os.environ["FORCE_COLOR"] = "1"
    os.execvpe(command[0], command, os.environ)

output = b""
cursor = 0
deadline = time.monotonic() + 35
status = None


def read_chunk():
    global output
    if time.monotonic() > deadline:
        raise AssertionError("wizard timed out")
    if select.select([fd], [], [], 0.1)[0]:
        try:
            output += os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    if len(output) > 2_000_000:
        raise AssertionError("unexpectedly large terminal output")


def wait_for(text):
    global cursor
    wanted = text.encode()
    while output.find(wanted, cursor) < 0:
        read_chunk()
    cursor = output.find(wanted, cursor) + len(wanted)
    # Let the prompt finish installing its key handler before sending input.
    time.sleep(0.04)


def send(value):
    os.write(fd, value)


try:
    wait_for("01 / routing" if "--api" in command else "Use native CLI workers")
    if mode == "secret":
        send(b"\r")
        wait_for("02 / provider")
        send(b"\r")
        wait_for("03 / model")
        send(b"\r")
        wait_for("02 / provider")
        send(b"\r")
        wait_for("03 / model")
        send(b"\r")
        wait_for("04 / credentials")
        send(b"\r")
        wait_for("Paste ARELAY_PTY_OPENAI_KEY")
        send(secret.encode() + b"\r")
        wait_for("04 / credentials")
        send(b"\x1b[B\r")  # Set the Anthropic key up later.
        wait_for("05 / service")
        send(b"\r")
        wait_for("06 / review")
        send(b"\x1b")
    else:
        send(b"\x03" if mode == "ctrl-c" else b"\x1b")
    while status is None:
        read_chunk()
        waited, result = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = result
    # Drain the PTY after child exit.
    for _ in range(5):
        if not select.select([fd], [], [], 0.02)[0]:
            break
        read_chunk()
    text = output.decode(errors="replace")
    assert os.waitstatus_to_exitcode(status) == 0, "wizard exited unsuccessfully"
    assert "cancelled" in text.lower(), "cancellation was not acknowledged"
    assert "arelay" in text, "application name was not rendered"
    assert secret not in text, "plaintext secret appeared in terminal output"
    assert "\x1b[?25h" in text, "terminal cursor was not restored"
    if "NO_COLOR" in os.environ:
        assert not re.search(r"\x1b\[3[0-7]m", text), "NO_COLOR was ignored"
    else:
        assert "\x1b[36m" in text, "colored branding was not rendered"
    if mode == "secret":
        assert "*****" in text, "password input was not masked"
        assert "your setup" in text, "routing preview was not rendered"
    print(json.dumps({"mode": mode, "passed": True, "terminal_bytes": len(output)}))
except BaseException:
    # Never dump a transcript that could contain the canary if masking regresses.
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    raise
finally:
    os.close(fd)
