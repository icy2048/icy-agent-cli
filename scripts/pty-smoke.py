"""Exercise the built CLI through a real POSIX PTY and local HTTP fixture.

No real model credentials or external model calls. Run after npm run build.
The separate Linux live-PTY report records agent-operated exploratory acceptance.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class Terminal:
    def __init__(self, root, env, args=()):
        self.raw = b""
        self.pid, self.fd = pty.fork()
        self.closed = False
        self.reaped = False
        if self.pid == 0:
            os.chdir(root / "workspace")
            os.execve(NODE, [NODE, str(REPO / "dist/cli.js"), *args], env)
        self.resize(80, 24)

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self):
        if self.closed:
            return
        if select.select([self.fd], [], [], 0.05)[0]:
            try:
                data = os.read(self.fd, 65536)
                self.raw += data
                if not data:
                    self.closed = True
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                self.closed = True

    def wait(self, predicate, label, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            if predicate():
                return
            if self.closed:
                break
        raise AssertionError(f"PTY timeout: {label}\n{self.screen()[-5000:]}")

    def screen(self, start=0):
        return ANSI.sub("", self.raw[start:].decode("utf-8", errors="replace"))

    def command(self, text):
        # A checkpoint can reach disk before React renders an editable prompt.
        # Wait for the current frame, rather than matching an older idle frame.
        self.wait(lambda: "输入你的目标" in ANSI.sub("", self.raw.rsplit(b"\x1b[?2026h", 1)[-1].decode("utf-8", errors="replace")), "editable prompt")
        # Ink may paint the restored view before its input effect enables raw
        # mode. A canonical terminal echo is not a rendered Composer draft.
        self.wait(lambda: not (termios.tcgetattr(self.fd)[3] & (termios.ICANON | termios.ECHO)), "raw input ready")
        start = len(self.raw)
        os.write(self.fd, text.encode())
        self.wait(lambda: re.search(r"❯\s*" + re.escape(text) + r"(?:\s|$)", self.screen(start)), f"draft {text}")
        os.write(self.fd, b"\r")

    def key(self, value):
        os.write(self.fd, value)

    def close(self):
        if not self.closed:
            self.command("/exit")
            self.wait(lambda: self.closed, "graceful exit")
        pid, status = os.waitpid(self.pid, 0)
        self.reaped = True
        assert pid == self.pid and os.waitstatus_to_exitcode(status) == 0
        os.close(self.fd)

    def terminate(self):
        if self.reaped:
            return
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


with tempfile.TemporaryDirectory(prefix="icy-pty-") as folder:
    root = Path(folder)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {"PATH": os.environ["PATH"], "HOME": str(root), "ICY_HOME": str(root / "home"), "ICY_PTY_KEY": "offline-pty-key", "ICY_PTY_PORT": str(port), "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
    server_log = open(root / "server.log", "wb")
    server = subprocess.Popen([NODE, str(REPO / "scripts/fixtures/pty-server.mjs"), str(root)], env=env, stdout=server_log, stderr=server_log)
    terminals = []

    def snapshots():
        result = []
        for file in (root / "home/sessions").glob("*/session.json"):
            try:
                result.append(json.loads(file.read_text()))
            except (FileNotFoundError, json.JSONDecodeError):
                pass
        return result

    def task(goal):
        return next((s for s in snapshots() if s.get("task", {}).get("goal") == goal), {})

    def status(goal, expected):
        return task(goal).get("task", {}).get("status") == expected

    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if server.poll() is not None:
                    raise AssertionError((root / "server.log").read_text())
                time.sleep(0.02)
        terminal = Terminal(root, env); terminals.append(terminal)
        terminal.wait(lambda: "Ready" in terminal.screen(), "initial UI")
        terminal.command("创建中文文件🙂")
        terminal.wait(lambda: status("创建中文文件🙂", "answered") and "已回答 · 未验证" in terminal.screen(), "answered state")
        terminal.command("/todo 核对中文🙂")
        terminal.wait(lambda: task("创建中文文件🙂").get("task", {}).get("remaining") == ["核对中文🙂"], "todo")
        terminal.command("/done 1")
        terminal.wait(lambda: task("创建中文文件🙂").get("task", {}).get("completed") == ["核对中文🙂"], "complete todo")
        terminal.command('/verify test "$(cat note.txt)" = "你好🙂"')
        terminal.wait(lambda: status("创建中文文件🙂", "awaiting_approval") and "允许执行命令" in terminal.screen(), "verification approval")
        terminal.key(b"y")
        terminal.wait(lambda: status("创建中文文件🙂", "verified") and "已验证完成" in terminal.screen(), "verified UI")
        verified_id = task("创建中文文件🙂")["id"]
        terminal.command("/new")
        terminal.wait(lambda: "新对话已开启" in terminal.screen(), "new session")
        terminal.command("执行长命令，然后观察取消")
        terminal.wait(lambda: status("执行长命令，然后观察取消", "awaiting_approval"), "bash approval")
        terminal.key(b"y")
        terminal.wait(lambda: (root / "workspace/slow.txt").exists(), "bash side effect")
        terminal.key(b"\x1b")
        terminal.wait(lambda: status("执行长命令，然后观察取消", "cancelled") and "已取消" in terminal.screen(), "cancelled UI")
        cancelled_id = task("执行长命令，然后观察取消")["id"]
        terminal.close()
        requests_before = (root / "requests.jsonl").read_bytes()
        terminal = Terminal(root, env, ["--resume", cancelled_id]); terminals.append(terminal)
        terminal.wait(lambda: "已取消" in terminal.screen() and "Exit code: signal" in terminal.screen(), "restored tool result")
        assert (root / "requests.jsonl").read_bytes() == requests_before
        terminal.command("/continue")
        terminal.wait(lambda: status("执行长命令，然后观察取消", "answered") and "已回答 · 未验证" in terminal.screen(), "explicit continuation")
        terminal.command(f"/resume {verified_id}")
        terminal.wait(lambda: f"已恢复会话 {verified_id}" in terminal.screen() and "已验证完成" in terminal.screen(), "session switch")
        terminal.key(b"\x0f")
        terminal.wait(lambda: "Exit code: 0" in terminal.screen(), "restored tool details")
        terminal.command("/new")
        terminal.wait(lambda: "新对话已开启" in terminal.screen(), "third session")
        terminal.command("拒绝这个命令")
        terminal.wait(lambda: status("拒绝这个命令", "awaiting_approval"), "denial prompt")
        terminal.key(b"n")
        terminal.wait(lambda: status("拒绝这个命令", "answered") and "permission_denied" in terminal.screen(), "denied result")
        terminal.resize(140, 45)
        terminal.command("/sessions")
        terminal.wait(lambda: "/resume <会话 ID>" in terminal.screen() and "│" in terminal.screen(), "wide discovery view")
        terminal.close()
        result = subprocess.run([NODE, str(REPO / "scripts/fixtures/verify-pty.mjs"), str(root)], env=env, capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)
        assert report["passed"]
        print(f"PTY smoke passed on {report['platform']} / {report['node']}: real stdin, approvals, cancellation, recovery, verification and resize.")
    except Exception:
        for index, terminal in enumerate(terminals):
            print(f"--- PTY {index + 1} ---\n{terminal.screen()[-6000:]}")
        raise
    finally:
        for terminal in terminals:
            terminal.terminate()
        server.terminate()
        try:
            server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill(); server.wait()
        server_log.close()
