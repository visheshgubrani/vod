"""
Network utilities for callbacks and URL validation.
"""
import os
import time
import socket
import ipaddress
from urllib.parse import urlparse

import requests

from config import ALLOWED_URL_HOSTS


def send_callback(url: str, data: dict, max_retries: int = 3) -> None:
    """
    Send webhook callback with exponential backoff retry.
    
    Args:
        url: Callback URL to POST to
        data: JSON data to send
        max_retries: Maximum retry attempts
    """
    print(f"📞 Sending callback to {url}...")
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                url,
                json=data,
                headers={
                    "X-Webhook-Secret": os.environ.get("MODAL_WEBHOOK_SECRET", ""),
                    "Content-Type": "application/json"
                },
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
    
    try:
        infos = socket.getaddrinfo(host, None)
        for info in infos:
            addr = info[4][0]
            ip = ipaddress.ip_address(addr)
            if (ip.is_private or ip.is_loopback or ip.is_link_local or 
                ip.is_multicast or ip.is_reserved or ip.is_unspecified):
                print(f"[SECURITY] Blocked private/reserved IP: {ip}")
                return False
    except Exception as e:
        print(f"[SECURITY] DNS resolution failed: {e}")
        return False
    
    return True
