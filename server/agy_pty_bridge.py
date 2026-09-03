#!/usr/bin/env python3
import sys, os, pty, subprocess, time, select, re, json

FIFO_CODE = "/tmp/agy_auth_code.fifo"
PID_FILE = "/tmp/agy_auth_pid.json"

def start_session():
    # Kill any existing session
    if os.path.exists(PID_FILE):
        try:
            with open(PID_FILE, "r") as f:
                d = json.load(f)
                os.kill(d["pid"], 9)
        except:
            pass
        try: os.remove(PID_FILE)
        except: pass

    master, slave = pty.openpty()
    p = subprocess.Popen(
        ["/usr/local/bin/agy", "-p", "ping test", "--output-format", "stream-json", "--dangerously-skip-permissions"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        cwd="/storage/workspace" if os.path.exists("/storage/workspace") else "/app"
    )
    os.close(slave)

    # Read output until auth URL is found
    output = ""
    auth_url = None
    start_time = time.time()

    while time.time() - start_time < 10:
        r, _, _ = select.select([master], [], [], 0.5)
        if master in r:
            try:
                chunk = os.read(master, 1024).decode("utf-8", errors="ignore")
                output += chunk
                m = re.search(r"https://accounts\.google\.com/o/oauth2/auth[^\s\x1b]+", output)
                if m:
                    auth_url = m.group(0)
                    break
            except:
                break

    if not auth_url:
        print(json.dumps({"ok": False, "error": "Could not extract auth URL", "output": output}))
        p.kill()
        os.close(master)
        return

    # Save master fd and pid for submit
    # Note: master fd cannot be passed across processes, so we fork a persistent background worker
    # that waits on a pipe or FIFO for the code
    if os.path.exists(FIFO_CODE):
        os.remove(FIFO_CODE)
    os.mkfifo(FIFO_CODE)

    # Fork background listener
    pid = os.fork()
    if pid == 0:
        # Child background process: holds master open, reads FIFO, writes to master
        try:
            with open(FIFO_CODE, "r") as fifo:
                code = fifo.read().strip()
            if code:
                os.write(master, (code + "\n").encode("utf-8"))
            
            # Wait up to 15s for agy to complete
            end_output = ""
            end_start = time.time()
            while time.time() - end_start < 15:
                r, _, _ = select.select([master], [], [], 0.5)
                if master in r:
                    try:
                        c = os.read(master, 1024).decode("utf-8", errors="ignore")
                        if not c: break
                        end_output += c
                    except:
                        break
            p.wait(timeout=5)
        except:
            pass
        finally:
            try: os.close(master)
            except: pass
            try: os.remove(FIFO_CODE)
            except: pass
            try: os.remove(PID_FILE)
            except: pass
            os._exit(0)

    # Parent process: writes PID info and prints auth URL
    with open(PID_FILE, "w") as f:
        json.dump({"pid": p.pid, "worker_pid": pid, "url": auth_url, "started": time.time()}, f)
    
    # Close master in parent
    os.close(master)
    print(json.dumps({"ok": True, "authUrl": auth_url}))

def submit_code(code):
    if not os.path.exists(FIFO_CODE):
        print(json.dumps({"ok": False, "error": "No active auth session waiting for code"}))
        return

    try:
        with open(FIFO_CODE, "w") as fifo:
            fifo.write(code + "\n")
        # Give worker a moment to complete
        time.sleep(3)
        print(json.dumps({"ok": True, "message": "Code submitted to agy via PTY"}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "submit":
        submit_code(sys.argv[2] if len(sys.argv) > 2 else "")
    else:
        start_session()
