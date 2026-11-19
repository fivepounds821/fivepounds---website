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
      const [orders, customers, transactions, expenses, products, ingredients, recipeItems, coffeeShopSales] = await Promise.all([
        db("orders?select=id,order_number,customer_id,customer_name,customer_phone,preferred_date,preferred_time,fulfillment_method,collection_point,delivery_address,notes,items,item_count,subtotal,discount,amount_due,status,paid,paid_at,rewards_opt_in_at_order,marketing_opt_in_at_order,created_at&order=created_at.desc&limit=500"),
        db("customer_summary?select=id,display_name,phone,rewards_opt_in,marketing_opt_in,created_at,completed_paid_orders,lifetime_spend,first_order_at,last_order_at,stamps_balance&order=last_order_at.desc.nullslast&limit=1000"),
        db("loyalty_transactions?select=id,customer_id,order_id,transaction_type,stamps_delta,description,created_at&order=created_at.desc&limit=300"),
        db("finance_expenses?select=id,expense_date,category,description,vendor,amount,payment_method,notes,created_at,updated_at&order=expense_date.desc,created_at.desc&limit=1000"),
        db("products?select=id,name,variant,category,description,selling_price,active,created_at,updated_at&order=name.asc,variant.asc&limit=1000"),
        db("ingredients?select=id,name,category,base_unit,purchase_pack_quantity,purchase_pack_unit,purchase_price,normalized_pack_quantity,unit_cost_per_base_unit,active,created_at,updated_at&order=name.asc&limit=1000"),
        db("product_recipe_items?select=product_id,ingredient_id,quantity,ingredient:ingredients(id,name,base_unit,unit_cost_per_base_unit,active)&order=created_at.asc&limit=3000"),
        db("coffee_shop_daily_sales?select=id,product_id,sales_date,quantity_sold,unit_price,channel,created_at,updated_at&order=sales_date.desc&limit=1000"),
      ]);
      return respond({ ok: true, orders, customers, transactions, expenses, products, ingredients, recipeItems, coffeeShopSales, adminEmail: email }, 200, origin);
    }



    if (action === "create_expense" || action === "update_expense") {
      const id = String(body.id || "");
      if (action === "update_expense" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return respond({ error: "Invalid expense ID." }, 400, origin);
      }
      const expenseDate = String(body.expenseDate || "");
      const category = String(body.category || "");
      const description = String(body.description || "").trim();
      const vendor = String(body.vendor || "").trim();
      const amount = Number(body.amount);
      const paymentMethod = String(body.paymentMethod || "Other");
      const notes = String(body.notes || "").trim();
      const categories = ["Ingredients & Materials", "Packaging", "Delivery & Transport", "Marketing & Promotion", "Equipment & Tools", "Utilities & Bills", "Other"];
      const paymentMethods = ["Cash", "Bank Transfer", "E-wallet", "Card", "Other"];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate) || Number.isNaN(Date.parse(expenseDate + "T00:00:00Z")) || new Date(expenseDate + "T00:00:00Z").toISOString().slice(0,10) !== expenseDate) {
        return respond({ error: "Please choose a valid expense date." }, 400, origin);
      }
      if (!categories.includes(category)) return respond({ error: "Please choose a valid expense category." }, 400, origin);
      if (!description || description.length > 240) return respond({ error: "Description must be between 1 and 240 characters." }, 400, origin);
      if (vendor.length > 120 || notes.length > 1000) return respond({ error: "Vendor or notes exceed the allowed length." }, 400, origin);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Math.round(amount * 100) !== amount * 100) {
        return respond({ error: "Please enter a valid expense amount in RM." }, 400, origin);
      }
      if (!paymentMethods.includes(paymentMethod)) return respond({ error: "Please choose a valid payment method." }, 400, origin);
      const payload = {
        expense_date: expenseDate,
        category,
        description,
        vendor: vendor || null,
        amount,
        payment_method: paymentMethod,
        notes: notes || null,
        updated_at: new Date().toISOString(),
      };
      const path = action === "create_expense"
        ? "finance_expenses?select=id,expense_date,category,description,vendor,amount,payment_method,notes,created_at,updated_at"
        : "finance_expenses?id=eq." + encodeURIComponent(id) + "&select=id,expense_date,category,description,vendor,amount,payment_method,notes,created_at,updated_at";
      const rows = await db(path, {
        method: action === "create_expense" ? "POST" : "PATCH",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify(payload),
      });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Expense could not be saved." }, 409, origin);
      return respond({ ok: true, expense: rows[0] }, action === "create_expense" ? 201 : 200, origin);
    }

    if (action === "delete_expense") {
      const id = String(body.id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return respond({ error: "Invalid expense ID." }, 400, origin);
      }
      const rows = await db("finance_expenses?id=eq." + encodeURIComponent(id) + "&select=id", {
        method: "DELETE",
        headers: { "Prefer": "return=representation" },
      });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Expense not found or could not be deleted." }, 404, origin);
      return respond({ ok: true, deletedExpenseId: id }, 200, origin);
    }


    if (action === "save_product") {
      const id = String(body.id || "");
      const updating = Boolean(id);
      if (updating && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return respond({ error: "Invalid product ID." }, 400, origin);
      const name = String(body.name || "").trim();
      const variant = String(body.variant || "").trim();
      const category = String(body.category || "Other").trim();
      const description = String(body.description || "").trim();
      const sellingPrice = Number(body.sellingPrice);
      if (!name || name.length > 120) return respond({ error: "Product name must be between 1 and 120 characters." }, 400, origin);
      if (variant.length > 80 || category.length > 80 || description.length > 1000) return respond({ error: "Product details exceed the allowed length." }, 400, origin);
      if (!Number.isFinite(sellingPrice) || sellingPrice <= 0 || sellingPrice > 100000 || Math.round(sellingPrice * 100) !== sellingPrice * 100) return respond({ error: "Enter a valid selling price in RM." }, 400, origin);
      const payload = { name, variant, category: category || "Other", description: description || null, selling_price: sellingPrice, updated_at: new Date().toISOString() };
      const path = updating ? "products?id=eq." + encodeURIComponent(id) + "&select=id,name,variant,category,description,selling_price,active,created_at,updated_at" : "products?select=id,name,variant,category,description,selling_price,active,created_at,updated_at";
      const rows = await db(path, { method: updating ? "PATCH" : "POST", headers: { "Prefer": "return=representation" }, body: JSON.stringify(payload) });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Product could not be saved. Check that this name and variant are not already in use." }, 409, origin);
      return respond({ ok: true, product: rows[0] }, updating ? 200 : 201, origin);
    }

    if (action === "archive_product" || action === "archive_ingredient") {
      const id = String(body.id || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return respond({ error: "Invalid record ID." }, 400, origin);
      const table = action === "archive_product" ? "products" : "ingredients";
      const rows = await db(table + "?id=eq." + encodeURIComponent(id) + "&select=id,active", { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }) });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Record not found or could not be archived." }, 404, origin);
      return respond({ ok: true, id }, 200, origin);
    }

    if (action === "save_ingredient") {
      const id = String(body.id || "");
      const updating = Boolean(id);
      if (updating && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return respond({ error: "Invalid ingredient ID." }, 400, origin);
      const name = String(body.name || "").trim();
      const category = String(body.category || "Other").trim();
      const baseUnit = String(body.baseUnit || "");
      const packUnit = String(body.packUnit || "");
      const packQty = Number(body.packQty);
      const purchasePrice = Number(body.purchasePrice);
      const compatible = { g: ["g", "kg"], ml: ["ml", "L"], pcs: ["pcs"] };
      if (!name || name.length > 120 || category.length > 80) return respond({ error: "Enter a valid ingredient name and category." }, 400, origin);
      if (!Object.prototype.hasOwnProperty.call(compatible, baseUnit) || !compatible[baseUnit].includes(packUnit)) return respond({ error: "Purchase pack unit must match the ingredient base unit." }, 400, origin);
      if (!Number.isFinite(packQty) || packQty <= 0 || packQty > 100000000 || Math.round(packQty * 1000) !== packQty * 1000) return respond({ error: "Enter a valid package quantity (up to 3 decimal places)." }, 400, origin);
      if (!Number.isFinite(purchasePrice) || purchasePrice <= 0 || purchasePrice > 100000 || Math.round(purchasePrice * 100) !== purchasePrice * 100) return respond({ error: "Enter a valid purchase price in RM." }, 400, origin);
      if (updating) {
        const existing = await db("ingredients?id=eq." + encodeURIComponent(id) + "&select=id,base_unit&limit=1");
        if (!Array.isArray(existing) || existing.length !== 1) return respond({ error: "Ingredient not found." }, 404, origin);
        if (existing[0].base_unit !== baseUnit) {
          const usage = await db("product_recipe_items?ingredient_id=eq." + encodeURIComponent(id) + "&select=product_id&limit=1");
          if (Array.isArray(usage) && usage.length > 0) return respond({ error: "This ingredient is already used in a recipe. Its base unit cannot be changed; keep the current unit or archive it and create a new ingredient." }, 409, origin);
        }
      }
      const payload = { name, category: category || "Other", base_unit: baseUnit, purchase_pack_quantity: packQty, purchase_pack_unit: packUnit, purchase_price: purchasePrice, updated_at: new Date().toISOString() };
      const path = updating ? "ingredients?id=eq." + encodeURIComponent(id) + "&select=id,name,category,base_unit,purchase_pack_quantity,purchase_pack_unit,purchase_price,normalized_pack_quantity,unit_cost_per_base_unit,active,created_at,updated_at" : "ingredients?select=id,name,category,base_unit,purchase_pack_quantity,purchase_pack_unit,purchase_price,normalized_pack_quantity,unit_cost_per_base_unit,active,created_at,updated_at";
      const rows = await db(path, { method: updating ? "PATCH" : "POST", headers: { "Prefer": "return=representation" }, body: JSON.stringify(payload) });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Ingredient could not be saved. Check whether the name is already in use." }, 409, origin);
      return respond({ ok: true, ingredient: rows[0] }, updating ? 200 : 201, origin);
    }

    if (action === "save_recipe") {
      const productId = String(body.productId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) return respond({ error: "Choose a valid product." }, 400, origin);
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) return respond({ error: "A recipe must contain between 1 and 100 ingredients." }, 400, origin);
      const seen = new Set();
      const items = [];
      for (const item of body.items) {
        const ingredientId = String(item?.ingredientId || "");
        const quantity = Number(item?.quantity);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ingredientId)) return respond({ error: "Choose an ingredient for every recipe line." }, 400, origin);
        if (seen.has(ingredientId)) return respond({ error: "Each ingredient can only appear once in a recipe." }, 400, origin);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000000 || Math.round(quantity * 1000) !== quantity * 1000) return respond({ error: "Recipe quantities must be positive and use up to 3 decimal places." }, 400, origin);
        seen.add(ingredientId);
        items.push({ ingredient_id: ingredientId, quantity });
      }
      const products = await db("products?id=eq." + encodeURIComponent(productId) + "&select=id&limit=1");
      if (!Array.isArray(products) || products.length !== 1) return respond({ error: "Product not found." }, 404, origin);
      const ingredients = await db("ingredients?id=in.(" + [...seen].join(",") + ")&active=eq.true&select=id");
      if (!Array.isArray(ingredients) || ingredients.length !== seen.size) return respond({ error: "One or more selected ingredients are inactive or unavailable." }, 409, origin);
      const result = await db("rpc/replace_product_recipe", { method: "POST", body: JSON.stringify({ p_product_id: productId, p_items: items }) });
      return respond({ ok: true, savedLines: result }, 200, origin);
    }

    if (action === "create_custom_order") {
      const name = String(body.name || "").trim();
      const phoneDigits = String(body.phone || "").replace(/\D/g, "");
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
      if (!/^60\d{8,10}$/.test(phone)) return respond({ error: "Please enter a valid Malaysian WhatsApp number." }, 400, origin);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond({ error: "Please choose a valid order date." }, 400, origin);
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
      ].filter(Boolean).join("\n");
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

    if (action === "save_coffee_shop_sale") {
      const salesDate = String(body.salesDate || "");
      const quantitySold = Number(body.quantitySold);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(salesDate) || new Date(salesDate + "T00:00:00Z").toISOString().slice(0,10) !== salesDate) {
        return respond({ error: "Please choose a valid sales date." }, 400, origin);
      }
      const day = new Date(salesDate + "T00:00:00Z").getUTCDay();
      if (![0,5,6].includes(day)) return respond({ error: "南洋提拉米苏只记录星期五、六、日的咖啡店销售。" }, 400, origin);
      if (!Number.isInteger(quantitySold) || quantitySold < 1 || quantitySold > 10000) return respond({ error: "Enter a whole number of cups sold (1–10,000)." }, 400, origin);
      const products = await db("products?select=id,name,variant,selling_price&name=eq." + encodeURIComponent("南洋提拉米苏") + "&variant=eq.Cup&active=eq.true&limit=1");
      if (!Array.isArray(products) || products.length !== 1) return respond({ error: "Please add an active product named 南洋提拉米苏 with variant Cup and selling price RM9.90 in Products first." }, 409, origin);
      if (Number(products[0].selling_price) !== 9.90) return respond({ error: "The 南洋提拉米苏 Cup product must have a selling price of RM9.90 before recording sales." }, 409, origin);
      const rows = await db("coffee_shop_daily_sales?on_conflict=product_id,sales_date,channel&select=id,product_id,sales_date,quantity_sold,unit_price,channel,created_at,updated_at", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ product_id: products[0].id, sales_date: salesDate, quantity_sold: quantitySold, unit_price: 9.90, channel: "coffee_shop", updated_at: new Date().toISOString() }),
      });
      if (!Array.isArray(rows) || rows.length !== 1) return respond({ error: "Daily sales could not be saved." }, 409, origin);
      return respond({ ok: true, sale: rows[0] }, 200, origin);
    }

    return respond({ error: "Unknown action." }, 400, origin);
  } catch (error) {
    console.error("admin-api error:", error);
    return respond({ error: error instanceof Error ? error.message : "Admin request failed." }, 500, origin);
  }
});
