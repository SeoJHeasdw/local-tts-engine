#!/usr/bin/env python3
"""Sample this capture process and its children without using ps/top.

macOS libproc's resident size includes shared pages in more than one process.
The sum is a diagnostic upper estimate, not physical memory owned by capture.
"""

import argparse
import ctypes
import json
import os
import re
import signal
import struct
import subprocess
import time


LIBPROC = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
LIBPROC.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
LIBPROC.proc_listallpids.restype = ctypes.c_int
LIBPROC.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
LIBPROC.proc_pidinfo.restype = ctypes.c_int
SHORT_BSD_INFO = 13
TASK_INFO = 4
STOP = False


def stop(_signal, _frame):
    global STOP
    STOP = True


def processes():
    pids = (ctypes.c_int * 32768)()
    count = LIBPROC.proc_listallpids(pids, ctypes.sizeof(pids))
    if count <= 0:
        raise RuntimeError("macOS process inventory unavailable")
    result = {}
    data = ctypes.create_string_buffer(256)
    for pid in pids[:count]:
        if LIBPROC.proc_pidinfo(pid, SHORT_BSD_INFO, 0, data, len(data)) < 64:
            continue
        found_pid, ppid = struct.unpack_from("II", data)
        name = data.raw[16:32].split(b"\0", 1)[0].decode("utf-8", "replace")
        result[found_pid] = (ppid, name)
    return result


def descendants(root_pid, inventory):
    selected = {root_pid}
    while True:
        more = {pid for pid, (ppid, _) in inventory.items() if ppid in selected}
        if more <= selected:
            return selected
        selected |= more


def resident_bytes(pid):
    data = ctypes.create_string_buffer(256)
    if LIBPROC.proc_pidinfo(pid, TASK_INFO, 0, data, len(data)) < 16:
        return None
    return struct.unpack_from("Q", data, 8)[0]


def system_free_percent():
    try:
        result = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True, timeout=2)
        match = re.search(r"System-wide memory free percentage: (\d+)%", result.stdout)
        return int(match.group(1)) if match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root-pid", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with open(args.output, "x", encoding="utf-8") as output:
        sample_index = 0
        while not STOP:
            inventory = processes()
            family = descendants(args.root_pid, inventory)
            # The sampler itself is a child of root, but is measurement overhead.
            family.discard(os.getpid())
            measured = []
            unmeasured_pids = []
            for pid in sorted(family):
                value = resident_bytes(pid)
                if value is None:
                    unmeasured_pids.append(pid)
                    continue
                ppid, name = inventory.get(pid, (None, "unknown"))
                measured.append({"pid": pid, "ppid": ppid, "name": name, "residentBytes": value})
            output.write(json.dumps({
                "unixMs": round(time.time() * 1000),
                "residentSumBytes": sum(item["residentBytes"] for item in measured),
                "rootVisible": args.root_pid in inventory,
                "knownFamilyRssComplete": args.root_pid in inventory and not unmeasured_pids,
                "unmeasuredPids": unmeasured_pids,
                "processes": measured,
                "systemFreePercent": system_free_percent() if sample_index % 5 == 0 else None,
            }) + "\n")
            output.flush()
            sample_index += 1
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
