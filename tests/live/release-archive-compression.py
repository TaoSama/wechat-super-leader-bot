#!/usr/bin/env python3
"""Measure real release archives on a local Unix Docker engine; never deploy."""

import argparse
import concurrent.futures
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

COMPONENTS = ("controller", "gateway")
TRANSFER_BYTES_PER_SECOND = 350_000
HEALTH_SECONDS = 360
CLEANUP_SECONDS = 30
VERIFY_ALLOWANCE_SECONDS = 60
JOB_BUDGET_SECONDS = 20 * 60
MAX_LOG_BYTES = 512 * 1024
COMMAND_SECONDS = 20 * 60
CLEANUP_COMMAND_SECONDS = 5
BUILDER_CLEANUP_SECONDS = 30
STOP_GRACE_SECONDS = 2


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Probe:
    def __init__(self, args):
        self.args = args
        self.root = Path(__file__).resolve().parents[2]
        self.output = args.output.resolve()
        if self.output.is_relative_to(self.root):
            raise ValueError("--output must be outside the checkout")
        self.started = time.time()
        self.logs = self.output.parent / (self.output.stem + "-logs")
        self.logs.mkdir(parents=True, exist_ok=False)
        self.temp = Path(tempfile.mkdtemp(prefix="release-archive-probe-"))
        self.token = uuid.uuid4().hex
        self.builder = "archive-probe-" + self.token
        self.container = "archive-probe-cli-" + self.token
        self.tags = {name: f"release-archive-probe-{name}:{self.token}" for name in COMPONENTS}
        self.processes = set()
        self.lock = threading.Lock()
        self.env = os.environ.copy()
        self.builder_created = False
        self.container_attempted = False
        self.engine_pinned = False
        self.cancelled = False
        self.loaded = set()
        self.report = {"revision": args.revision, "measurement_correct": False,
                       "commands": [], "images": {}, "errors": [],
                       "safety": "Local Unix Docker only; no push, registry authentication or deployment."}

    def command(self, label, command, *, stdout_path=None, expected_success=True, cpu=True,
                timeout_seconds=COMMAND_SECONDS):
        if self.cancelled:
            raise InterruptedError("Probe cancelled before command start")
        log = self.logs / (label + ".log")
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.monotonic()
        timed_out = False
        with log.open("wb") as diagnostic:
            with (stdout_path.open("wb") if stdout_path else contextlib.nullcontext(diagnostic)) as output:
                process = subprocess.Popen(command, cwd=self.root, env=self.env,
                                           stdout=output, stderr=diagnostic, start_new_session=True)
                with self.lock:
                    self.processes.add(process)
                try:
                    while process.poll() is None:
                        if self.cancelled or time.monotonic() - started >= timeout_seconds:
                            timed_out = not self.cancelled
                            self.stop_process(process)
                        else:
                            try:
                                process.wait(timeout=0.25)
                            except subprocess.TimeoutExpired:
                                continue
                    status = process.returncode
                finally:
                    if process.poll() is not None:
                        with self.lock:
                            self.processes.discard(process)
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        entry = {"label": label, "argv": command, "exit_code": status,
                 "wall_seconds": time.monotonic() - started,
                 "user_seconds": after.ru_utime - before.ru_utime if cpu else None,
                 "sys_seconds": after.ru_stime - before.ru_stime if cpu else None,
                 "cpu_scope": "CLI child processes only; excludes Docker daemon CPU",
                 "timed_out": timed_out,
                 "log": str(log), "log_sha256": sha256(log)}
        if log.stat().st_size > MAX_LOG_BYTES:
            with log.open("rb") as stream:
                beginning = stream.read(MAX_LOG_BYTES // 2)
                stream.seek(-MAX_LOG_BYTES // 2, os.SEEK_END)
                ending = stream.read()
            log.write_bytes(beginning + b"\n[bounded log: middle omitted]\n" + ending)
            entry["retained_log_sha256"] = sha256(log)
        with self.lock:
            self.report["commands"].append(entry)
        if self.cancelled:
            raise InterruptedError(f"Probe cancelled during {label}")
        if timed_out:
            raise TimeoutError(f"{label} exceeded {timeout_seconds} seconds; see {log}")
        if expected_success and status:
            raise RuntimeError(f"{label} exited {status}; see {log}")
        return entry, log

    def json_command(self, label, command):
        output = self.logs / (label + "-stdout.log")
        entry, _ = self.command(label, command, stdout_path=output)
        entry.update({"stdout_log": str(output), "stdout_sha256": sha256(output)})
        return json.loads(output.read_text())

    def prepare(self):
        if self.args.gha_cache and not (self.env.get("ACTIONS_RUNTIME_TOKEN") and
                (self.env.get("ACTIONS_CACHE_URL") or self.env.get("ACTIONS_RESULTS_URL"))):
            raise RuntimeError("--gha-cache requires explicitly exported Actions runtime token and cache/results URL")
        _, log = self.command("git-revision", ["git", "rev-parse", "HEAD"])
        if log.read_text().strip() != self.args.revision:
            raise RuntimeError("Checked-out HEAD must exactly match --revision")
        _, log = self.command("git-status", ["git", "status", "--porcelain", "--untracked-files=normal"])
        if log.read_text().strip():
            raise RuntimeError("Probe requires a clean checkout of the exact revision")
        host = self.env.get("DOCKER_HOST")
        if host and not host.startswith("unix:///"):
            raise RuntimeError("DOCKER_HOST must be a local absolute Unix socket")
        if not host or self.env.get("DOCKER_CONTEXT"):
            context = self.env.get("DOCKER_CONTEXT")
            command = ["docker", "context", "inspect"] + ([context] if context else [])
            contexts = self.json_command("docker-context", command)
            host = contexts[0]["Endpoints"]["docker"]["Host"]
        if not host.startswith("unix:///") or not Path(host.removeprefix("unix://")).is_socket():
            raise RuntimeError("Selected Docker context must point to a local Unix socket")
        for variable in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "BUILDX_BUILDER"):
            self.env.pop(variable, None)
        self.env["DOCKER_HOST"] = host
        self.engine_pinned = True
        info = self.json_command("docker-info", ["docker", "info", "--format", "{{json .}}"])
        if info["OSType"] != "linux":
            raise RuntimeError("A Linux Docker engine is required")
        self.report["environment"] = {"docker_host": host, "engine": info,
                                      "python": sys.version, "runner": os.uname()._asdict() if hasattr(os.uname(), "_asdict") else list(os.uname())}
        self.command("docker-version", ["docker", "version"])
        self.command("buildx-version", ["docker", "buildx", "version"])
        # Own builder and explicit socket prevent a selected remote builder from being used.
        self.builder_created = True
        self.command("builder-create", ["docker", "buildx", "create", "--name", self.builder,
                                       "--driver", "docker-container", host])
        self.command("builder-inspect", ["docker", "buildx", "inspect", "--bootstrap", self.builder])

    def build(self, name):
        command = ["docker", "buildx", "build", "--builder", self.builder,
                   "--platform", "linux/amd64", "--build-arg", f"VCS_REF={self.args.revision}",
                   "--tag", self.tags[name], "--provenance=false", "--sbom=false",
                   "--output", f"type=docker,dest={self.temp / (name + '.tar')}",
                   "--file", f"deploy/Dockerfile.{name}"]
        if self.args.gha_cache:
            command += ["--cache-from", f"type=gha,scope={name}"]
        result, _ = self.command(name + "-build", command + ["."], cpu=False)
        return result["wall_seconds"]

    def archive_structure(self, path):
        with tarfile.open(path, "r:") as archive:
            members = archive.getmembers()
            result = {"first_members": [{"name": item.name, "bytes": item.size} for item in members[:20]], "layers": [],
                      "npm_cache": {"prefix": "root/.npm/_cacache/", "archived_file_bytes": 0,
                                    "file_count": 0, "largest_files": [],
                                    "meaning": "Sum of archived regular files across layers; not the merged filesystem."}}
            # Docker exporter can include OCI descriptors alongside the Docker manifest.
            for member in members:
                if member.isfile() and member.size < 4 * 1024 * 1024:
                    stream = archive.extractfile(member)
                    prefix = stream.read(1)
                    if prefix != b"{":
                        continue
                    try:
                        value = json.loads(prefix + stream.read())
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    for layer in value.get("layers", []) if isinstance(value, dict) else []:
                        result["layers"].append({key: layer.get(key) for key in ("digest", "mediaType", "size")})
            manifest = next((item for item in members if item.name == "manifest.json"), None)
            if manifest:
                for image in json.load(archive.extractfile(manifest)):
                    for layer in image.get("Layers", []):
                        item = archive.getmember(layer)
                        magic = archive.extractfile(item).read(2)
                        result["layers"].append({"name": layer, "bytes": item.size,
                                                 "gzip_magic": magic == b"\x1f\x8b"})
                        with tarfile.open(fileobj=archive.extractfile(item), mode="r|*") as filesystem:
                            for entry in filesystem:
                                filename = entry.name.removeprefix("./").lstrip("/")
                                if entry.isfile() and filename.startswith("root/.npm/_cacache/"):
                                    cache = result["npm_cache"]
                                    cache["archived_file_bytes"] += entry.size
                                    cache["file_count"] += 1
                                    cache["largest_files"].append({"path": filename, "bytes": entry.size, "layer": layer})
                                    cache["largest_files"] = sorted(cache["largest_files"], key=lambda value: value["bytes"], reverse=True)[:20]
            return result

    def inspect(self, name, label):
        values = self.json_command(label, ["docker", "image", "inspect", self.tags[name]])
        value = values[0]
        identity = {"id": value["Id"], "platform": value["Os"] + "/" + value["Architecture"],
                    "revision": value["Config"]["Labels"].get("org.opencontainers.image.revision")}
        if identity["platform"] != "linux/amd64" or identity["revision"] != self.args.revision:
            raise RuntimeError(f"Unexpected {name} image metadata: {identity}")
        return identity

    def measure(self, name):
        raw = self.temp / (name + ".tar")
        compressed = self.temp / (name + "-gzip-content.tar")
        restored = self.temp / (name + "-restored.tar")
        result = {"raw_bytes": raw.stat().st_size, "raw_sha256": sha256(raw),
                  "archive": self.archive_structure(raw)}
        self.report["images"][name] = result
        if result["archive"]["npm_cache"]["archived_file_bytes"]:
            raise RuntimeError(f"{name} release archive retains npm install cache")
        compression, _ = self.command(name + "-gzip-1", ["gzip", "-n", "-1", "-c", str(raw)], stdout_path=compressed)
        self.command(name + "-gunzip", ["gzip", "-d", "-c", str(compressed)], stdout_path=restored)
        result.update({"gzip_bytes": compressed.stat().st_size, "gzip_sha256": sha256(compressed),
                       "restored_sha256": sha256(restored), "compression_seconds": compression["wall_seconds"]})
        if result["restored_sha256"] != result["raw_sha256"]:
            raise RuntimeError(f"{name} gzip round trip changed archive contents")
        restored.unlink()
        self.loaded.add(name)
        raw_load, _ = self.command(name + "-load-raw", ["docker", "load", "--input", str(raw)])
        identity = self.inspect(name, name + "-inspect-raw")
        self.command(name + "-remove-before-gzip-load", ["docker", "image", "rm", self.tags[name]])
        gzip_load, _ = self.command(name + "-load-gzip", ["docker", "load", "--input", str(compressed)])
        if self.inspect(name, name + "-inspect-gzip") != identity:
            raise RuntimeError(f"{name} compressed archive changed image identity")
        if name == "controller":
            self.container_attempted = True
            _, log = self.command("controller-cli-version", ["docker", "run", "--rm", "--name", self.container,
                                  "--network", "none", "--entrypoint", "codex", self.tags[name], "--version"])
            result["cli_version"] = log.read_text().strip()
            if result["cli_version"] != "codex-cli 0.163.0":
                raise RuntimeError(f"Unexpected controller CLI version: {result['cli_version']}")
        truncated = self.temp / (name + "-truncated.tar")
        with compressed.open("rb") as source, truncated.open("wb") as target:
            remaining = compressed.stat().st_size // 2
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                target.write(chunk)
                remaining -= len(chunk)
        failure, _ = self.command(name + "-load-truncated", ["docker", "load", "--input", str(truncated)], expected_success=False)
        if failure["exit_code"] == 0 or self.inspect(name, name + "-inspect-after-truncated") != identity:
            raise RuntimeError(f"{name} truncated gzip was accepted or changed the image tag")
        result.update({"identity": identity, "raw_load_seconds": raw_load["wall_seconds"],
                       "gzip_load_seconds": gzip_load["wall_seconds"], "truncated_load_rejected": True,
                       "saved_fraction": 1 - result["gzip_bytes"] / result["raw_bytes"]})
        for path in (raw, compressed, truncated):
            path.unlink()

    def budget(self, build_seconds):
        images = list(self.report["images"].values())
        setup = self.report["setup_wall_seconds"]
        job_start = self.env.get("ARCHIVE_PROBE_JOB_STARTED")
        pre_script = self.started - float(job_start) if job_start else None
        local_load = sum(item["raw_load_seconds"] for item in images)
        fixed = (pre_script or 0) + setup + build_seconds + local_load + HEALTH_SECONDS + CLEANUP_SECONDS + VERIFY_ALLOWANCE_SECONDS
        raw = fixed + sum(item["raw_load_seconds"] + item["raw_bytes"] / TRANSFER_BYTES_PER_SECOND for item in images)
        gzip = fixed + sum(item["compression_seconds"] + item["gzip_load_seconds"] + item["gzip_bytes"] / TRANSFER_BYTES_PER_SECOND for item in images)
        self.report["budget"] = {"build_parallel_wall_seconds": build_seconds, "raw_seconds": raw,
                                 "build_cache_mode": "read-only GHA cache" if self.args.gha_cache else "cold isolated builder; not a production warm-cache estimate",
                                 "gzip_seconds": gzip, "limit_seconds": JOB_BUDGET_SECONDS,
                                 "raw_fits": raw <= JOB_BUDGET_SECONDS, "gzip_fits": gzip <= JOB_BUDGET_SECONDS,
                                 "health_seconds": HEALTH_SECONDS, "cleanup_seconds": CLEANUP_SECONDS,
                                 "verify_allowance_seconds": VERIFY_ALLOWANCE_SECONDS,
                                 "local_inspection_load_seconds": local_load, "setup_wall_seconds": setup,
                                 "pre_script_setup_seconds": pre_script, "whole_job_setup_included": job_start is not None,
                                 "transfer_bytes_per_second": TRANSFER_BYTES_PER_SECOND,
                                 "assumption": "0.35 MB/s and remote load at local measured duration are scenarios, not guarantees. Raw load above is the additional remote load; local inspection load is counted separately. Missing pre-script timing makes whole-job budget incomplete. Runner allocation/queue is excluded; this is not deployment acceptance."}
        self.report["compress_effective"] = job_start is not None and gzip < raw and gzip <= JOB_BUDGET_SECONDS

    def stop_process(self, process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait()
            return
        try:
            process.wait(timeout=STOP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                process.wait()
            process.wait()

    def cleanup(self):
        # Stop and reap only children started by this probe before removing their files.
        with self.lock:
            running = list(self.processes)
        for process in running:
            self.stop_process(process)
        self.cancelled = False
        if self.container_attempted and self.engine_pinned:
            try:
                check, log = self.command("cleanup-cli-container", ["docker", "container", "rm", "--force", self.container],
                                          expected_success=False, timeout_seconds=CLEANUP_COMMAND_SECONDS)
                if check["exit_code"] and "No such container" not in log.read_text():
                    raise RuntimeError("Cannot remove owned CLI probe container")
            except Exception as error:
                self.report["errors"].append(f"Container cleanup: {error}")
        for name in self.loaded if self.engine_pinned else ():
            try:
                check, _ = self.command(name + "-cleanup-inspect", ["docker", "image", "inspect", self.tags[name]],
                                        expected_success=False, timeout_seconds=CLEANUP_COMMAND_SECONDS)
                if check["exit_code"] == 0:
                    self.command(name + "-cleanup-image", ["docker", "image", "rm", self.tags[name]],
                                 timeout_seconds=CLEANUP_COMMAND_SECONDS)
                elif "No such image" not in (self.logs / (name + "-cleanup-inspect.log")).read_text():
                    raise RuntimeError(f"Cannot determine whether {name} probe image remains")
            except Exception as error:
                self.report["errors"].append(f"Image cleanup: {error}")
        if self.builder_created:
            try:
                self.command("cleanup-builder", ["docker", "buildx", "rm", self.builder],
                             timeout_seconds=BUILDER_CLEANUP_SECONDS)
            except Exception as error:
                self.report["errors"].append(f"Builder cleanup: {error}")
        try:
            shutil.rmtree(self.temp)
        except OSError as error:
            self.report["errors"].append(f"Temporary directory cleanup: {error}")

    def persist_report(self):
        temporary = self.output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.report, indent=2) + "\n")
        temporary.replace(self.output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Actually build and load isolated probe images")
    parser.add_argument("--revision", required=True, help="Exact checked-out 40-character commit SHA")
    parser.add_argument("--output", type=Path, required=True, help="JSON report path outside the checkout")
    parser.add_argument("--gha-cache", action="store_true", help="Read (never write) controller/gateway GHA caches")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        parser.error("--revision must be a full lowercase 40-character commit SHA")
    if not args.run:
        print("Dry run: pass --run to measure isolated real images on a local Unix Docker engine.")
        return 0
    probe = Probe(args)
    def cancelled(signum, _frame):
        probe.cancelled = True
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, cancelled)
    try:
        probe.prepare()
        probe.report["setup_wall_seconds"] = time.time() - probe.started
        started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(COMPONENTS)) as pool:
            list(pool.map(probe.build, COMPONENTS))
        build_seconds = time.monotonic() - started
        for name in COMPONENTS:
            probe.measure(name)
        probe.budget(build_seconds)
        if probe.cancelled:
            raise InterruptedError("Probe cancelled")
        probe.report["measurement_correct"] = True
    except Exception as error:
        probe.report["errors"].append(f"{type(error).__name__}: {error}")
    finally:
        probe.report["cleanup_finished"] = False
        try:
            probe.persist_report()
        except Exception as error:
            probe.report["errors"].append(f"Pre-cleanup report: {type(error).__name__}: {error}")
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, signal.SIG_IGN)
        try:
            probe.cleanup()
        except Exception as error:
            probe.report["errors"].append(f"Cleanup: {type(error).__name__}: {error}")
        if probe.report["errors"]:
            probe.report["measurement_correct"] = False
        probe.report["cleanup_finished"] = True
        probe.persist_report()
        print(f"Report: {probe.output}\nEvidence logs: {probe.logs}")
    return 0 if probe.report["measurement_correct"] else 1


if __name__ == "__main__":
    sys.exit(main())
