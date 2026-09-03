#!/usr/bin/env python3
"""
PTY bridge for headless `agy` login on Linux (Railway).

Commands:
  start              spawn agy in a real pseudoterminal, print the Google auth URL as JSON,
                     leave a background worker holding the PTY open until agy exits.
  submit <code>      hand the pasted authorization code to the waiting agy process, then wait
                     for agy to finish and print its output tail + exit code.
  status             print current session state and agy output tail.
  report             list every file agy created/modified since `start` (no guessing where
                     the login is stored: the filesystem tells us).

All state lives under /tmp/agy_auth so the Node server can call this script repeatedly.
"""
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

SESSION_DIR = "/tmp/agy_auth"
MARKER = os.path.join(SESSION_DIR, "marker")
FIFO = os.path.join(SESSION_DIR, "code.fifo")
STATE = os.path.join(SESSION_DIR, "state.json")
OUTPUT = os.path.join(SESSION_DIR, "output.log")

AGY_BIN = os.environ.get("AGY_BIN", "/usr/local/bin/agy")
WORKDIR = "/storage/workspace" if os.path.isdir("/storage/workspace") else "/app"
URL_RE = re.compile(r"https://accounts\.google\.com/o/oauth2/auth[^\s\x1b\"']+")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
MAX_SESSION_SECONDS = 15 * 60


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")
    sys.stdout.flush()


def read_json(path, default=None):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def output_tail(limit=4000):
    try:
        with open(OUTPUT, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            data = f.read().decode("utf-8", errors="ignore")
        return ANSI_RE.sub("", data)
    except Exception:
        return ""


def kill_previous():
    state = read_json(STATE) or {}
    for key in ("agy_pid", "worker_pid"):
        pid = state.get(key)
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
    for p in (FIFO, STATE, OUTPUT):
        try:
            os.remove(p)
        except Exception:
            pass


def start_session():
    os.makedirs(SESSION_DIR, exist_ok=True)
    kill_previous()

    # Filesystem marker: `report` lists everything newer than this file.
    with open(MARKER, "w") as f:
        f.write(str(time.time()))
    # Make sure the marker is strictly older than anything agy writes.
    time.sleep(1.1)

    # The worker (child) owns agy for its whole life so proc.wait()/poll() work.
    # It reports the auth URL back to us through a pipe, then keeps running detached.
    pipe_r, pipe_w = os.pipe()
    worker_pid = os.fork()
    if worker_pid != 0:
        os.close(pipe_w)
        chunks = []
        while True:
            data = os.read(pipe_r, 65536)
            if not data:
                break
            chunks.append(data)
        os.close(pipe_r)
        text = b"".join(chunks).decode("utf-8", errors="ignore").strip()
        try:
            result = json.loads(text)
        except Exception:
            result = {"ok": False, "error": "worker produced no result", "raw": text[-2000:]}
        emit(result)
        return

    # ---- worker ----
    os.close(pipe_r)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    log = open(OUTPUT, "ab", buffering=0)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    os.setsid()

    def report_to_parent(obj):
        try:
            os.write(pipe_w, json.dumps(obj).encode("utf-8"))
        except Exception:
            pass
        try:
            os.close(pipe_w)
        except Exception:
            pass

    master, slave = pty.openpty()
    env = dict(os.environ)
    env.setdefault("HOME", "/root")
    env["TERM"] = "xterm-256color"
    try:
        proc = subprocess.Popen(
            [AGY_BIN, "-p", "Reply with exactly the word pong.", "--output-format", "text",
             "--dangerously-skip-permissions", "--print-timeout", "120s"],
            stdin=slave, stdout=slave, stderr=slave,
            close_fds=True, cwd=WORKDIR, env=env, start_new_session=True,
        )
    except Exception as e:
        write_json(STATE, {"phase": "spawn_failed", "done": True, "error": str(e)})
        report_to_parent({"ok": False, "error": "failed to spawn agy: %s" % e})
        os._exit(1)
    os.close(slave)

    write_json(STATE, {"phase": "starting", "done": False, "agy_pid": proc.pid,
                       "worker_pid": os.getpid(), "started": time.time()})

    def pump(timeout):
        """Read one chunk from the PTY (or return None on timeout / EOF)."""
        r, _, _ = select.select([master], [], [], timeout)
        if master not in r:
            return None
        try:
            chunk = os.read(master, 4096)
        except OSError:
            return b""
        if chunk:
            log.write(chunk)
        return chunk

    output = ""
    auth_url = None
    deadline = time.time() + 20
    while time.time() < deadline:
        chunk = pump(0.5)
        if chunk == b"":
            break
        if chunk:
            output += chunk.decode("utf-8", errors="ignore")
            m = URL_RE.search(ANSI_RE.sub("", output))
            if m:
                auth_url = m.group(0)
                break
        elif proc.poll() is not None:
            break

    if not auth_url:
        # Either agy is already logged in (it answered the prompt) or something else happened.
        drain_until = time.time() + 5
        while time.time() < drain_until and proc.poll() is None:
            chunk = pump(0.3)
            if chunk == b"":
                break
            if chunk:
                output += chunk.decode("utf-8", errors="ignore")
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        clean = ANSI_RE.sub("", output)
        write_json(STATE, {"phase": "no_url", "done": True, "exitCode": proc.returncode,
                           "started": time.time()})
        report_to_parent({"ok": False, "error": "agy did not print a Google auth URL within 20s",
                          "alreadyLoggedIn": "pong" in clean.lower(), "exitCode": proc.returncode,
                          "output": clean[-3000:]})
        os._exit(0)

    os.mkfifo(FIFO)
    write_json(STATE, {
        "phase": "waiting_for_code", "done": False, "agy_pid": proc.pid,
        "worker_pid": os.getpid(), "authUrl": auth_url, "urlSeenAt": time.time(),
        "started": time.time(),
    })
    report_to_parent({
        "ok": True, "authUrl": auth_url, "agyPid": proc.pid,
        "note": "agy itself only waits ~60s for the code after printing the URL. Sign in and paste the code quickly.",
    })

    # Hold the session: wait for the code on the FIFO, relay it, and keep reading until agy exits.
    code_sent = False
    exit_code = None
    try:
        fifo_fd = os.open(FIFO, os.O_RDWR | os.O_NONBLOCK)  # O_RDWR: never EOF while waiting
        end = time.time() + MAX_SESSION_SECONDS
        master_open = True
        while time.time() < end:
            fds = []
            if not code_sent:
                fds.append(fifo_fd)
            if master_open:
                fds.append(master)
            if not fds:
                break
            r, _, _ = select.select(fds, [], [], 0.5)
            if fifo_fd in r and not code_sent:
                data = os.read(fifo_fd, 4096).decode("utf-8", errors="ignore").strip()
                if data:
                    os.write(master, (data + "\n").encode("utf-8"))
                    code_sent = True
                    st = read_json(STATE) or {}
                    st.update({"phase": "code_sent", "codeSentAt": time.time()})
                    write_json(STATE, st)
            if master in r:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    master_open = False
                else:
                    log.write(chunk)
            if proc.poll() is not None:
                # agy exited: drain what is left, then stop.
                drain = time.time() + 1
                while master_open and time.time() < drain:
                    r2, _, _ = select.select([master], [], [], 0.2)
                    if master not in r2:
                        break
                    try:
                        c2 = os.read(master, 4096)
                    except OSError:
                        break
                    if not c2:
                        break
                    log.write(c2)
                break
        if proc.poll() is None:
            proc.kill()
        exit_code = proc.wait()
        st = read_json(STATE) or {}
        st.update({"phase": "done", "done": True, "exitCode": exit_code,
                   "finishedAt": time.time(), "codeSent": code_sent})
        write_json(STATE, st)
    except Exception as e:
        st = read_json(STATE) or {}
        st.update({"phase": "worker_error", "done": True, "error": str(e), "codeSent": code_sent})
        write_json(STATE, st)
    finally:
        try:
            os.close(master)
        except Exception:
            pass
        try:
            os.remove(FIFO)
        except Exception:
            pass
        os._exit(0)


def submit_code(code, wait_seconds=60):
    state = read_json(STATE)
    if not state or state.get("done") or not os.path.exists(FIFO):
        emit({"ok": False, "error": "No agy login session is waiting for a code. Click 'Generate link' again.",
              "state": state, "outputTail": output_tail()})
        return
    try:
        fd = os.open(FIFO, os.O_WRONLY | os.O_NONBLOCK)
        os.write(fd, (code + "\n").encode("utf-8"))
        os.close(fd)
    except OSError as e:
        emit({"ok": False, "error": "Could not hand the code to agy: %s" % e, "state": state,
              "outputTail": output_tail()})
        return

    deadline = time.time() + wait_seconds
    final = None
    while time.time() < deadline:
        time.sleep(1)
        final = read_json(STATE) or {}
        if final.get("done"):
            break
    tail = output_tail()
    lowered = tail.lower()
    emit({
        "ok": True,
        "agyExited": bool(final and final.get("done")),
        "exitCode": (final or {}).get("exitCode"),
        "phase": (final or {}).get("phase"),
        "looksAuthenticated": ("pong" in lowered) and ("not logged in" not in lowered),
        "looksFailed": any(k in lowered for k in ("invalid_grant", "authentication failed", "timed out", "error")),
        "outputTail": tail[-3000:],
    })


def status():
    emit({"ok": True, "state": read_json(STATE), "fifoExists": os.path.exists(FIFO),
          "markerExists": os.path.exists(MARKER), "outputTail": output_tail()[-3000:]})


SKIP_DIRS = ("/proc", "/sys", "/dev", "/run", "/app/node_modules", "/tmp/agy_auth", "/var/lib", "/var/cache")


def report():
    if not os.path.exists(MARKER):
        emit({"ok": False, "error": "No marker from a previous `start`; nothing to compare against."})
        return
    marker_mtime = os.path.getmtime(MARKER)
    roots = [p for p in ("/root", "/storage", "/tmp", "/app", "/etc", "/var") if os.path.isdir(p)]
    found = []
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            if any(dirpath == s or dirpath.startswith(s + "/") for s in SKIP_DIRS):
                dirnames[:] = []
                continue
            # agy's own per-run logs are noise; keep the directory name visible but skip the files.
            if dirpath.endswith("/antigravity-cli/log") or dirpath.endswith("/antigravity-cli/crashes"):
                dirnames[:] = []
                continue
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    st = os.lstat(full)
                except OSError:
                    continue
                if st.st_mtime <= marker_mtime:
                    continue
                entry = {"path": full, "size": st.st_size,
                         "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
                         "onPersistentVolume": os.path.realpath(full).startswith("/storage/")}
                if name.endswith(".json") and st.st_size < 200000:
                    try:
                        with open(full, "r") as f:
                            data = json.load(f)
                        if isinstance(data, dict):
                            entry["jsonKeys"] = sorted(data.keys())[:40]
                        elif isinstance(data, list):
                            entry["jsonKeys"] = ["<array len=%d>" % len(data)]
                    except Exception:
                        entry["jsonKeys"] = ["<unparseable>"]
                found.append(entry)
    found.sort(key=lambda e: e["mtime"])
    emit({"ok": True, "since": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(marker_mtime)),
          "count": len(found), "files": found[:200],
          "geminiDirIsSymlink": os.path.islink("/root/.gemini"),
          "geminiDirTarget": os.path.realpath("/root/.gemini")})


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    if cmd == "start":
        start_session()
    elif cmd == "submit":
        submit_code(sys.argv[2] if len(sys.argv) > 2 else "")
    elif cmd == "status":
        status()
    elif cmd == "report":
        report()
    else:
        emit({"ok": False, "error": "unknown command %r" % cmd})
