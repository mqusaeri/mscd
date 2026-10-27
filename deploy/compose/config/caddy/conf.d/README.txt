Optional extra Caddy sites for the MSCD SaaS stack, imported by ../Caddyfile.

Every file here whose name ends in .caddy is loaded when Caddy starts, for example
ops.caddy for the dashboards host ops.<domain> (Milestone 2 plan, M2-S08). A file can
use the snippets of the Caddyfile: "import mscd_tls" for the certificate settings and
"import mscd_log" for the access log without query strings.

After adding or changing a file: docker compose up -d --force-recreate caddy
