const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLISHABLE_KEYS = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
const PUBLISHABLE_KEY = PUBLISHABLE_KEYS.default || Deno.env.get("SUPABASE_ANON_KEY") || "";

const allowedOrigins = new Set([
  "https://fivepounds821.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function respond(data: unknown, status = 200, origin: string | null = null) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(JSON.stringify(data), { status, headers });
}

async function readJson(response: Response) {
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data?.message || data?.error_description || data?.hint || "Database request failed");
  return data;
}

async function db(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("apikey", SERVICE_ROLE_KEY);
  headers.set("Authorization", `Bearer ${SERVICE_ROLE_KEY}`);
  headers.set("Content-Type", "application/json");
  return readJson(await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers }));
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return respond({ error: "Origin not allowed" }, 403);
  if (req.method === "OPTIONS") {
    const headers = new Headers({
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "86400",
    });
    if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405, origin);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PUBLISHABLE_KEY) return respond({ error: "Server is not configured" }, 500, origin);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "Please sign in first." }, 401, origin);

  try {
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": PUBLISHABLE_KEY, "Authorization": authHeader },
    });
    if (!userResponse.ok) return respond({ error: "Your session is invalid or expired. Please sign in again." }, 401, origin);
    const user = await userResponse.json();
    const email = String(user.email || "").trim().toLowerCase();
    if (!email || !user.email_confirmed_at) return respond({ error: "A verified email account is required." }, 403, origin);

    const allowed = await db(`admin_allowlist?select=email&email=eq.${encodeURIComponent(email)}&limit=1`);
    if (!Array.isArray(allowed) || allowed.length !== 1) {
      return respond({ error: "This email is not authorised for the FIVEPOUNDS admin dashboard." }, 403, origin);
    }

    const body = await req.json();
    const action = String(body.action || "");

    if (action === "dashboard") {
      const [orders, customers, transactions] = await Promise.all([
        db("orders?select=id,order_number,customer_id,customer_name,customer_phone,preferred_date,preferred_time,fulfillment_method,collection_point,delivery_address,notes,items,item_count,subtotal,discount,amount_due,status,paid,paid_at,rewards_opt_in_at_order,marketing_opt_in_at_order,created_at&order=created_at.desc&limit=500"),
        db("customer_summary?select=id,display_name,phone,rewards_opt_in,marketing_opt_in,created_at,completed_paid_orders,lifetime_spend,first_order_at,last_order_at,stamps_balance&order=last_order_at.desc.nullslast&limit=1000"),
        db("loyalty_transactions?select=id,customer_id,order_id,transaction_type,stamps_delta,description,created_at&order=created_at.desc&limit=300"),
      ]);
      return respond({ ok: true, orders, customers, transactions, adminEmail: email }, 200, origin);
    }


    if (action === "create_custom_order") {
      const name = String(body.name || "").trim();
      const phoneDigits = String(body.phone || "").replace(/\\D/g, "");
      const phone = phoneDigits.startsWith("60") ? phoneDigits : phoneDigits.startsWith("0") ? "60" + phoneDigits.slice(1) : phoneDigits;
      const date = String(body.date || "");
      const time = String(body.time || "").trim();
      const method = String(body.method || "");
      const collectionPoint = String(body.collectionPoint || "");
      const address = String(body.address || "").trim();
      const description = String(body.description || "").trim();
      const qty = Number(body.qty);
      const subtotal = Number(body.subtotal);
      const notes = String(body.notes || "").trim();
      const rewardsOptIn = body.rewardsOptIn === true;

      if (!name || name.length > 80) return respond({ error: "Please enter a valid customer name." }, 400, origin);
      if (!/^60\\d{8,10}$/.test(phone)) return respond({ error: "Please enter a valid Malaysian WhatsApp number." }, 400, origin);
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return respond({ error: "Please choose a valid order date." }, 400, origin);
      const chosenDate = new Date(date + "T00:00:00Z");
      if (Number.isNaN(chosenDate.getTime()) || chosenDate.toISOString().slice(0, 10) !== date) {
        return respond({ error: "Please choose a valid order date." }, 400, origin);
      }
      const malaysiaToday = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      if (date < malaysiaToday) {
        return respond({ error: "Past order dates are not allowed." }, 400, origin);
      }
      const weekday = chosenDate.getUTCDay();
      if (weekday !== 0 && weekday !== 6) return respond({ error: "Orders are only available on Saturday and Sunday." }, 400, origin);
      if (!time || time.length > 40) return respond({ error: "Please enter the agreed collection or delivery time." }, 400, origin);
      if (method !== "Self Collection" && method !== "Grab Express") return respond({ error: "Please choose a valid fulfilment method." }, 400, origin);
      if (method === "Self Collection" && !["Sin Chooi Hong Kopitiam", "Taman Pulasan"].includes(collectionPoint)) {
        return respond({ error: "Please choose a valid collection point." }, 400, origin);
      }
      if (method === "Grab Express" && address.length < 8) return respond({ error: "Please enter the full delivery address." }, 400, origin);
      if (!description || description.length > 500) return respond({ error: "Please enter a valid custom cake description." }, 400, origin);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return respond({ error: "Quantity must be between 1 and 20." }, 400, origin);
      if (!Number.isFinite(subtotal) || subtotal <= 0 || subtotal > 10000 || Math.round(subtotal * 100) !== subtotal * 100) {
        return respond({ error: "Please enter a valid subtotal in RM." }, 400, origin);
      }
      if (notes.length > 1000) return respond({ error: "Notes must be 1,000 characters or fewer." }, 400, origin);

      const existingCustomers = await db("customers?select=id,rewards_opt_in,rewards_consent_at&phone=eq." + encodeURIComponent(phone) + "&limit=1");
      const existing = Array.isArray(existingCustomers) ? existingCustomers[0] : null;
      const now = new Date().toISOString();
      const customerPayload = {
        phone,
        display_name: name,
        rewards_opt_in: rewardsOptIn || existing?.rewards_opt_in === true,
        rewards_consent_at: rewardsOptIn ? (existing?.rewards_consent_at || now) : (existing?.rewards_consent_at || null),
      };
      const customers = await db("customers?on_conflict=phone", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(customerPayload),
      });
      const customerId = customers?.[0]?.id || existing?.id;
      if (!customerId) return respond({ error: "Customer record could not be created." }, 502, origin);

      const orderNotes = [
        "Custom cake: " + description,
        notes ? "Notes: " + notes : "",
      ].filter(Boolean).join("\\n");
      const orderPayload = {
        customer_id: customerId,
        customer_name: name,
        customer_phone: phone,
        preferred_date: date,
        preferred_time: time,
        fulfillment_method: method,
        collection_point: method === "Self Collection" ? collectionPoint : null,
        delivery_address: method === "Grab Express" ? address : null,
        notes: orderNotes,
        items: [{ product: "Custom Cake", size: description, qty, unit_price: Number((subtotal / qty).toFixed(2)), line_total: subtotal }],
        item_count: qty,
        subtotal,
        discount: 0,
        amount_due: subtotal,
        status: "pending",
        paid: false,
        paid_at: null,
        rewards_opt_in_at_order: rewardsOptIn,
        marketing_opt_in_at_order: false,
      };
      const orders = await db("orders?select=id,order_number,customer_id,customer_name,customer_phone,preferred_date,preferred_time,fulfillment_method,collection_point,delivery_address,notes,items,item_count,subtotal,discount,amount_due,status,paid,paid_at,rewards_opt_in_at_order,created_at", {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify(orderPayload),
      });
      if (!Array.isArray(orders) || orders.length !== 1) return respond({ error: "Custom order could not be created." }, 502, origin);
      return respond({ ok: true, order: orders[0] }, 201, origin);
    }

    if (action === "delete_cancelled_order") {
      const id = String(body.id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return respond({ error: "Invalid order ID." }, 400, origin);
      }
      const orders = await db(`orders?id=eq.${encodeURIComponent(id)}&select=id,status,paid&limit=1`);
      if (!Array.isArray(orders) || orders.length !== 1) return respond({ error: "Order not found." }, 404, origin);
      if (orders[0].status !== "cancelled") return respond({ error: "Only cancelled orders can be deleted." }, 409, origin);
      if (orders[0].paid) return respond({ error: "This order is marked paid. Resolve/refund the payment before deletion." }, 409, origin);
      const transactions = await db(`loyalty_transactions?order_id=eq.${encodeURIComponent(id)}&select=id&limit=1`);
      if (Array.isArray(transactions) && transactions.length > 0) return respond({ error: "This order has a loyalty transaction. It cannot be deleted without reconciling the stamp ledger." }, 409, origin);
      const deleted = await db(`orders?id=eq.${encodeURIComponent(id)}&select=id`, {
        method: "DELETE",
        headers: { "Prefer": "return=representation" },
      });
      if (!Array.isArray(deleted) || deleted.length !== 1) return respond({ error: "Order could not be deleted." }, 409, origin);
      return respond({ ok: true, deletedOrderId: id }, 200, origin);
    }

    if (action === "update_order") {
      const id = String(body.id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return respond({ error: "Invalid order ID." }, 400, origin);
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const allowedStatuses = ["pending", "confirmed", "preparing", "ready", "completed", "cancelled"];
      if (body.status !== undefined) {
        if (!allowedStatuses.includes(body.status)) return respond({ error: "Invalid order status." }, 400, origin);
        patch.status = body.status;
      }
      if (body.paid === true) {
        patch.paid = true;
        patch.paid_at = new Date().toISOString();
      } else if (body.paid === false) {
        return respond({ error: "Payment cannot be reversed from this dashboard. Contact support for a correction." }, 400, origin);
      }
      if (Object.keys(patch).length === 1) return respond({ error: "No order changes supplied." }, 400, origin);
      const rows = await db(`orders?id=eq.${encodeURIComponent(id)}&select=id,order_number,status,paid,paid_at,discount,amount_due`, {
        method: "PATCH",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Order not found or could not be updated." }, 404, origin);
      return respond({ ok: true, order: rows[0] }, 200, origin);
    }

    if (action === "redeem_reward") {
      const id = String(body.orderId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return respond({ error: "Invalid order ID." }, 400, origin);
      }
      const result = await readJson(await fetch(`${SUPABASE_URL}/rest/v1/rpc/redeem_fivepounds_reward`, {
        method: "POST",
        headers: {
          "apikey": SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_order_id: id }),
      }));
      return respond({ ok: true, result }, 200, origin);
    }

    return respond({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    console.error("admin-api error:", error);
    return respond({ error: error instanceof Error ? error.message : "Admin request failed." }, 500, origin);
  }
});
