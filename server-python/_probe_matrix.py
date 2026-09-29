import ipaddress, security
hosts = ["0.0.0.0","0.1.2.3","100.64.0.1","100.127.255.255","192.0.0.1","192.0.0.170","198.18.0.1","224.0.0.1","239.255.255.255","240.0.0.1","255.255.255.255","8.8.8.8","172.15.0.1","172.32.0.1","169.254.1.1","10.0.0.1","127.0.0.1","192.168.1.1","100.100.100.200"]
for h in hosts:
    ip = ipaddress.ip_address(h)
    g = lambda n: getattr(ip, n, "n/a")
    print(f"{h:18} blocked={str(security._is_blocked_ip(h) is not None):5} private={str(g('is_private')):5} reserved={str(g('is_reserved')):5} mc={str(g('is_multicast')):5} ll={str(g('is_link_local')):5} unspec={str(g('is_unspecified')):5}")
