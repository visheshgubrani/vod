"""
Command execution utilities with timing and error handling.
"""
import subprocess
import time


def run_cmd(cmd: list[str], *, label: str = "cmd", check: bool = True) -> subprocess.CompletedProcess:
    """
    Execute subprocess with timing and error handling.
    
    Args:
        cmd: Command and arguments to execute
        label: Label for logging
        check: If True, raise RuntimeError on non-zero exit code
        
    Returns:
        CompletedProcess with stdout, stderr, returncode
        
    Raises:
        RuntimeError: If check=True and command fails
    """
    print(f"[CMD] {label}: {' '.join(cmd[:3])}...")
    start = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.time() - start
    
    if check and p.returncode != 0:
        stderr_tail = "\n".join((p.stderr or "").splitlines()[-50:])
        raise RuntimeError(
            f"{label} failed in {elapsed:.1f}s (exit={p.returncode}).\n"
            f"STDERR:\n{stderr_tail}"
        )
    
    print(f"[CMD] {label}: completed in {elapsed:.1f}s")
    return p
