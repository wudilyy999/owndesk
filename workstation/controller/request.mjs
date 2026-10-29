// Docker exec helper. Credentials stay out of command arguments and workflow records.
let body = ""
for await (const chunk of process.stdin) body += chunk
const response = await fetch(`http://127.0.0.1:6079${process.argv[2]}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.PA_WORKSPACE_TOKEN}`,
  },
  body,
})
const text = await response.text()
process.stdout.write(text)
if (!response.ok) process.exit(1)
