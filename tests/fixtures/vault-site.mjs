import { createServer } from "node:http"

const state = {
  mode: "normal",
  expected: {},
  events: [],
  changed: false,
  submissions: 0,
  signedIn: false,
  merchant: "Fixture Store",
  amount: "USD 12.00",
  manualActions: 0,
  slowReady: false,
  inspectionStartedAt: null,
  inspectionFinishedAt: null,
  buttonLabel: "Pay USD 12.00",
  paymentMatches: false,
  receipt: null,
  paymentMethod: "card",
  mutationApplied: null,
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8083")
  if (request.method === "POST") {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (url.pathname === "/settings") {
      state.expected = body.expected
      state.mode = body.mode
      state.paymentMethod = body.paymentMethod
    } else if (url.pathname === "/mode") state.mode = body.mode
    else if (url.pathname === "/checkout") {
      if (body.amount !== undefined) state.amount = body.amount
      if (body.merchant !== undefined) state.merchant = body.merchant
      if (body.buttonLabel !== undefined) state.buttonLabel = body.buttonLabel
    } else if (url.pathname === "/pay") {
      state.submissions++
      state.paymentMatches = Object.entries(state.expected)
        .filter(([field]) =>
          state.paymentMethod === "upi" ? field === "id" : field !== "id"
        )
        .every(([field, value]) => body[field] === value)
      state.receipt = `fixture-order-${state.submissions}`
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          `<h2 id="merchant">${state.merchant}</h2><p id="amount">${state.amount}</p><p id="status">${state.paymentMatches ? "Fixture payment recorded" : "Fixture payment rejected"}</p><p id="receipt">${state.receipt}</p>`
        )
      return
    } else if (url.pathname === "/manual") {
      state.manualActions++
      state.submissions++
    } else if (url.pathname === "/slow-ready") state.slowReady = true
    else if (url.pathname === "/inspection-start") state.inspectionStartedAt ??= body.at
    else if (url.pathname === "/inspection-end") state.inspectionFinishedAt ??= body.at
    else if (url.pathname === "/changed") state.changed = true
    else if (url.pathname === "/mutation-applied") state.mutationApplied = body.mode
    else if (url.pathname === "/input")
      state.events.push({
        field: body.field,
        matched: body.value === state.expected[body.field],
        masked: body.masked === true,
      })
    else if (url.pathname === "/login") {
      state.submissions++
      state.signedIn = Object.entries(state.expected).every(
        ([field, value]) => body[field] === value
      )
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end(state.signedIn ? "<h1>Signed in</h1>" : "<h1>Sign in failed</h1>")
      return
    } else throw new Error("Unexpected fixture POST")
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}")
    return
  }
  if (url.pathname === "/health") {
    response.end("ready")
    return
  }
  if (url.pathname === "/state") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        mode: state.mode,
        events: state.events,
        changed: state.changed,
        submissions: state.submissions,
        signedIn: state.signedIn,
        merchant: state.merchant,
        amount: state.amount,
        manualActions: state.manualActions,
        slowReady: state.slowReady,
        inspectionStartedAt: state.inspectionStartedAt,
        inspectionFinishedAt: state.inspectionFinishedAt,
        buttonLabel: state.buttonLabel,
        paymentMatches: state.paymentMatches,
        receipt: state.receipt,
        paymentMethod: state.paymentMethod,
        mutationApplied: state.mutationApplied,
      })
    )
    return
  }
  if (url.pathname === "/mode") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        mode: state.mode,
        merchant: state.merchant,
        amount: state.amount,
        buttonLabel: state.buttonLabel,
      })
    )
    return
  }
  if (url.pathname === "/moved") {
    response.end("<h1>The page changed after the first field</h1>")
    return
  }
  const code = url.searchParams.get("kind") === "code"
  const identity = url.searchParams.get("kind") === "identity"
  const payment = url.searchParams.get("kind") === "payment"
  const identityInputs = Object.keys(state.expected)
    .map((field) => {
      if (state.mode === "select" && field === "country")
        return '<label>country<select name="country" aria-label="country"><option value="">Choose</option><option value="fixture">Fixture</option></select></label>'
      if (field === "address")
        return '<label>address<textarea name="address" aria-label="address"></textarea></label>'
      return `<label>${field}<input name="${field}" aria-label="${field}" type="${field === "email" ? "email" : field === "phone" ? "tel" : "text"}"></label>`
    })
    .join("")
  response.writeHead(200, { "Content-Type": "text/html" })
    .end(`<!doctype html><html><head><title>Controlled credential form</title></head><body>
  <h1>Controlled credential form</h1>${payment ? '<h2 id="merchant">Fixture Store</h2><p id="amount">USD 12.00</p>' : ""}<form>
  ${identity || payment ? identityInputs : code ? '<label>Code<input name="code" type="text" aria-label="Code"></label>' : '<label>Username<input name="username" aria-label="Username"></label><label>Password<input name="password" type="password" aria-label="Password"></label>'}
  <button type="submit">${payment && state.mode === "submit" ? state.buttonLabel : "Sign in"}</button></form>${payment && state.mode === "manual" ? '<button type="button" id="manual" autofocus>Simulate manual payment</button>' : ""}<script>
  let mode=${JSON.stringify(state.mode)},pinnedAmount=null,appliedMutation=null;
  setInterval(async()=>{
    const update=await(await fetch('/mode')).json();
    if(appliedMutation===update.mode)return;
    const button=document.querySelector('form button');
    let applied=false;
    if(update.mode==='cross_site'&&button){button.form.action='https://other.fixture.test/pay';applied=true}
    if(update.mode==='special_control'&&button){const div=document.createElement('div');div.setAttribute('role','button');div.setAttribute('data-pa-ref',button.getAttribute('data-pa-ref'));div.textContent=button.textContent;button.replaceWith(div);applied=true}
    if(update.mode==='iframe'&&button){const frame=document.createElement('iframe');document.body.append(frame);frame.contentDocument.body.append(button);applied=true}
    if(update.mode==='guest_change'&&button){button.type='button';applied=true}
    if(update.mode==='result_missing'&&document.querySelector('#receipt')){document.querySelector('#receipt').remove();applied=true}
    if(update.mode==='result_amount'&&document.querySelector('#receipt')){document.querySelector('#amount').textContent=update.amount;applied=true}
    if(update.mode==='result_merchant'&&document.querySelector('#receipt')){document.querySelector('#merchant').textContent=update.merchant;applied=true}
    if(applied){appliedMutation=update.mode;await fetch('/mutation-applied',{method:'POST',body:JSON.stringify({mode:update.mode})})}
  },100);
  setInterval(async()=>{const update=await(await fetch('/mode')).json();mode=update.mode;const input=document.querySelector('[name=password]');if(mode==='changed'&&!input.dataset.changed){input.setAttribute('aria-label','Changed target');input.dataset.changed='true';await fetch('/changed',{method:'POST',body:'{}'})}if(mode==='normal'&&input?.disabled)input.disabled=false;const merchant=document.querySelector('#merchant'),amount=document.querySelector('#amount');if(merchant&&mode==='slow_payment'&&!merchant.dataset.slow){const native=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText').get;Object.defineProperty(merchant,'innerText',{get(){fetch('/inspection-start',{method:'POST',body:JSON.stringify({at:Date.now()})});const end=performance.now()+1500;while(performance.now()<end){};fetch('/inspection-end',{method:'POST',body:JSON.stringify({at:Date.now()})});return native.call(this)}});merchant.dataset.slow='true';fetch('/slow-ready',{method:'POST',body:'{}'})}if(merchant)merchant.textContent=update.merchant;if(amount)amount.textContent=pinnedAmount??update.amount},100);
  for(const input of document.querySelectorAll('input,textarea,select')){
    input.addEventListener('input',()=>{
      fetch('/input',{method:'POST',body:JSON.stringify({field:input.name,value:input.value,masked:getComputedStyle(input).webkitTextSecurity==='disc'}),keepalive:true});
      if(mode==='partial'&&['username','name'].includes(input.name))location.href='/moved';
      if(mode==='payment_change'&&input.name==='number'){pinnedAmount='USD 13.00';document.querySelector('#amount').textContent=pinnedAmount;fetch('/checkout',{method:'POST',body:JSON.stringify({amount:'USD 13.00'})})}
    });
    if(input.name==='password')new MutationObserver(()=>{if(['timeout','hold'].includes(mode)&&input.style.webkitTextSecurity==='disc')input.disabled=true}).observe(input,{attributes:true,attributeFilter:['style']});
  }
  ${payment && state.mode === "submit" ? "setInterval(async()=>{const state=await(await fetch('/mode')).json();const button=document.querySelector('form button');if(button)button.textContent=state.buttonLabel},100);" : ""}
  document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const body={};for(const input of document.querySelectorAll('input'))body[input.name]=input.value;const result=await fetch('${payment && state.mode === "submit" ? "/pay" : "/login"}',{method:'POST',body:JSON.stringify(body)});document.body.innerHTML=await result.text()});
  document.querySelector('#manual')?.addEventListener('click',async()=>{await fetch('/manual',{method:'POST',body:'{}'});document.body.innerHTML='<h1>Manual payment simulated</h1>'});
  </script></body></html>`)
})
server.listen(8083, "127.0.0.1", () => console.log("Controlled vault site ready"))
