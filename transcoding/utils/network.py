"""
Network utilities for callbacks and URL validation.
"""
import os
import time
import socket
import ipaddress
from urllib.parse import urlparse, urljoin

import requests

from config import ALLOWED_URL_HOSTS, ALLOWED_CALLBACK_HOSTS


LOCALHOST_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _host_resolves_to_public_ip(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
        for info in infos:
            addr = info[4][0]
            ip = ipaddress.ip_address(addr)
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
                or ip.is_unspecified
            ):
                print(f"[SECURITY] Blocked private/reserved IP: {ip}")
                return False
    except Exception as e:
        print(f"[SECURITY] DNS resolution failed: {e}")
        return False

    return True


def send_callback(url: str, data: dict, max_retries: int = 3) -> None:
    """
    Send webhook callback with exponential backoff retry.
    
    Args:
        url: Callback URL to POST to
        data: JSON data to send
        max_retries: Maximum retry attempts
    """
    if not is_allowed_callback_url(url):
        print(f"[SECURITY] Blocked callback URL: {url}")
        return

    print(f"📞 Sending callback to {url}...")
    for attempt in range(max_retries):
        try:
            headers = {"Content-Type": "application/json"}
            secret = os.environ.get("MODAL_WEBHOOK_SECRET")
            if secret:
                headers["X-Webhook-Secret"] = secret

            resp = requests.post(
                url,
                json=data,
                headers=headers,
                timeout=15
            )
            resp.raise_for_status()
            print(f"✅ Callback delivered: {resp.status_code}")
            return
        except Exception as e:
            if attempt == max_retries - 1:
                print(f"❌ Callback failed after {max_retries} attempts: {e}")
            else:
                wait_time = 2 ** attempt
                print(f"⚠️ Callback attempt {attempt+1} failed. Retrying in {wait_time}s...")
                time.sleep(wait_time)


def is_public_host(url: str) -> bool:
    """
    SSRF protection: validate URL is HTTPS and resolves to public IP.
    
    Args:
        url: URL to validate
        
    Returns:
        True if URL is safe to fetch, False otherwise
    """
    u = urlparse(url)
    if u.scheme.lower() != "https":
        print(f"[SECURITY] Blocked non-HTTPS URL")
        return False
    
    host = (u.hostname or "").lower()
    if not host:
        return False
    
    if ALLOWED_URL_HOSTS and host not in ALLOWED_URL_HOSTS:
        print(f"[SECURITY] Host not in allowlist: {host}")
        return False
    
    return _host_resolves_to_public_ip(host)


def is_allowed_callback_url(url: str) -> bool:
    """
    Validate callback destinations to prevent exfiltration and SSRF.
    """
    u = urlparse(url)
    scheme = u.scheme.lower()
    host = (u.hostname or "").lower()
    if not host:
        return False

    is_local = host in LOCALHOST_HOSTS

    if ALLOWED_CALLBACK_HOSTS:
        if host not in ALLOWED_CALLBACK_HOSTS:
            print(f"[SECURITY] Callback host not in allowlist: {host}")
            return False
    elif not is_local:
        # Fail closed in production-like environments unless explicitly allowlisted.
        print("[SECURITY] No callback allowlist configured; only localhost callbacks are allowed")
        return False

    if is_local:
        if scheme not in ("http", "https"):
            print("[SECURITY] Blocked callback URL with invalid scheme for localhost")
            return False
        return True

    if scheme != "https":
        print("[SECURITY] Blocked non-HTTPS callback URL")
        return False

    return _host_resolves_to_public_ip(host)


def download_public_url(url: str, output_path: str, max_redirects: int = 5) -> None:
    """
    Download a public HTTPS URL with redirect validation on every hop.
    """
    current_url = url
    seen_urls = {current_url}

    for redirect_count in range(max_redirects + 1):
        if not is_public_host(current_url):
            raise ValueError("URL blocked by security policy")

        with requests.get(
            current_url,
            stream=True,
            allow_redirects=False,
            timeout=(15, 600),
        ) as resp:
            if 300 <= resp.status_code < 400:
                location = resp.headers.get("Location")
                if not location:
                    raise ValueError("Redirect response missing Location header")

                next_url = urljoin(current_url, location)
                if next_url in seen_urls:
                    raise ValueError("Redirect loop detected")

                seen_urls.add(next_url)
                current_url = next_url
                print(f"[SECURITY] Following validated redirect {redirect_count + 1}: {next_url}")
                continue

            resp.raise_for_status()
            with open(output_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
            return

    raise ValueError(f"Too many redirects (>{max_redirects})")
