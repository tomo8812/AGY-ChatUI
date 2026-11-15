#!/usr/bin/env python3
"""
Minimal zero-dependency PTY bridge for unmodified `agy acp --login` authorization-code flow.

Runs inside a user-isolated environment (custom HOME / XDG_* / cleared DBUS/GUI env).
Forces a very wide PTY window (2400 columns) so Google authorization URLs never line-wrap,
strips ANSI escapes when emitting structured JSON events on stdout, and accepts commands on
stdin as JSON lines:
  {"type": "code", "code": "..."}
  {"type": "cancel"}

NEVER reads or parses any credential/token file.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import threading

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r")
AUTH_URL_RE = re.compile(r"https://accounts\.google\.com/[^\s\"'<>]+")
ANY_HTTP_URL_RE = re.compile(r"https://[^\s\"'<>]+")


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def set_pty_size(fd: int, rows: int = 40, cols: int = 2400) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main() -> int:
    if len(sys.argv) < 2:
        emit({"type": "error", "message": "Missing command to execute in PTY"})
        return 2

    cmd = sys.argv[1:]
    master_fd, slave_fd = pty.openpty()
    set_pty_size(slave_fd, 40, 2400)
    set_pty_size(master_fd, 40, 2400)

    env = os.environ.copy()
    env["COLUMNS"] = "2400"
    env["LINES"] = "40"
    env["TERM"] = "xterm"

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
    except FileNotFoundError as exc:
        os.close(master_fd)
        os.close(slave_fd)
        emit({"type": "error", "message": f"Executable not found: {exc}"})
        return 127
    except Exception as exc:
        os.close(master_fd)
        os.close(slave_fd)
        emit({"type": "error", "message": f"Failed to start login process: {exc}"})
        return 1
    finally:
        try:
            os.close(slave_fd)
        except OSError:
            pass

    stop_event = threading.Event()
    emitted_urls: set[str] = set()

    def stdin_reader() -> None:
        while not stop_event.is_set():
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            if msg_type == "code":
                code = str(msg.get("code", "")).strip()
                if code:
                    try:
                        os.write(master_fd, (code + "\r").encode("utf-8"))
                        emit({"type": "code_submitted"})
                    except OSError as exc:
                        emit({"type": "error", "message": f"Failed to write code to PTY: {exc}"})
            elif msg_type == "cancel":
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except OSError:
                    try:
                        proc.terminate()
                    except OSError:
                        pass
                break

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    buffer = ""
    while True:
        rlist, _, _ = select.select([master_fd], [], [], 0.2)
        if master_fd in rlist:
            try:
                chunk = os.read(master_fd, 65536)
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):
                    break
                raise
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            cleaned = ANSI_RE.sub("", text)
            buffer += cleaned
            lines = buffer.split("\n")
            buffer = lines.pop()
            for raw_line in lines:
                line = raw_line.strip()
                if not line:
                    continue
                emit({"type": "output", "line": line})
                for match in AUTH_URL_RE.findall(line):
                    if match not in emitted_urls:
                        emitted_urls.add(match)
                        emit({"type": "auth_url", "url": match})
                if not emitted_urls:
                    for match in ANY_HTTP_URL_RE.findall(line):
                        if "oauth" in match.lower() or "authorize" in match.lower() or "antigravity" in match.lower():
                            if match not in emitted_urls:
                                emitted_urls.add(match)
                                emit({"type": "auth_url", "url": match})

            # Also check incomplete buffer (e.g. prompt without trailing newline)
            partial = buffer.strip()
            if partial:
                for match in AUTH_URL_RE.findall(partial):
                    if match not in emitted_urls:
                        emitted_urls.add(match)
                        emit({"type": "auth_url", "url": match})
                if "authorization code" in partial.lower() or "enter code" in partial.lower() or "paste" in partial.lower():
                    emit({"type": "awaiting_code", "prompt": partial})
        else:
            if proc.poll() is not None:
                # Drain remaining bytes if any
                try:
                    while True:
                        r2, _, _ = select.select([master_fd], [], [], 0.05)
                        if master_fd not in r2:
                            break
                        chunk = os.read(master_fd, 65536)
                        if not chunk:
                            break
                        buffer += ANSI_RE.sub("", chunk.decode("utf-8", errors="replace"))
                except OSError:
                    pass
                break

    if buffer.strip():
        line = buffer.strip()
        emit({"type": "output", "line": line})
        for match in AUTH_URL_RE.findall(line):
            if match not in emitted_urls:
                emitted_urls.add(match)
                emit({"type": "auth_url", "url": match})

    stop_event.set()
    try:
        os.close(master_fd)
    except OSError:
        pass

    code = proc.wait()
    emit({"type": "exit", "code": code})
    return code


if __name__ == "__main__":
    sys.exit(main())
