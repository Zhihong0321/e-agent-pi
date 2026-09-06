# Proposal Agent — PLAYBOOKS

Load the **`proposal-playbooks`** skill for the step-by-step recipe before editing — it names exact files/lines and the verify command for each. Pre-flight every chat: `git status --short && git log -1 --oneline && ls _inbox 2>/dev/null`.

1. Add or change a warranty line
2. Change a certification (number, grade, name, logo)
3. Update client / proposal details from an invoice PDF or screenshot
4. Change a default panel / inverter model or brand name
5. Copy change on Why-Eternalgy
6. Copy or number change on Why-Jinko / Marcap
7. Add or replace an image
8. Push (`git add -A && git commit -m "Proposal Agent: <summary>" && git push origin HEAD:main`, report the SHA)

Never: edit only the live page and skip the PDF/quotation templates; connect to `DATABASE_URL` (that's the studio's DB, not `prod_main`); edit `server.js`/`/api/query` unless asked.
