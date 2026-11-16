FROM node:22-alpine

WORKDIR /app

# No runtime dependencies: the daemon, proxy, and dashboard are dependency-free node.
# The proxy imports the client library (TanClient), so client/ ships in the image too.
COPY package.json README.md ./
COPY client ./client
COPY daemon ./daemon
COPY proxy ./proxy
COPY dashboard ./dashboard

# Default user; consumers typically override `user:` to match the uid that owns
# the host-side socket and audit volumes.
USER node

# Defaults (override with command flags or env):
#   UDS  /run/take-a-number/tan.sock      (mount a host dir at this path)
#   TCP  0.0.0.0:4100 inside the container — docker port publishing forwards
#        to the container's bridge IP, which a loopback bind never sees; the
#        isolation is the host-side publish (127.0.0.1:HOSTPORT:4100).
#   config /etc/take-a-number/config.json (mount read-write)
#   audit  /var/lib/take-a-number/audit   (mount a host dir)
#   TAN_AUTH_TOKEN                         (optional ?token= gate on the API)
#
# The same image runs the admission proxy with a command override:
#   ["node", "proxy/main.js", "--upstream", "127.0.0.1:4000", "--listen", "0.0.0.0:4140"]
CMD ["node", "daemon/main.js", "--tcp", "0.0.0.0:4100", "--allow-non-loopback"]
