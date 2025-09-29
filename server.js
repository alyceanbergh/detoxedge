import express from "express";
import cookieParser from "cookie-parser";
import { MongoClient } from "mongodb";
import { nanoid } from "nanoid";
import Stripe from "stripe";
import {
  addMinutes, isBefore, isAfter, parseISO, formatISO,
  areIntervalsOverlapping, startOfDay, setHours, setMinutes, setSeconds, isSameDay
} from "date-fns";
import { Resend } from "resend";

/* =========================
   ENV / CONFIG
   ========================= */
const {
  PORT = 3000,
  STRIPE_SECRET_KEY = "sk_test_xxx",
  STRIPE_PUBLIC_KEY = "pk_test_xxx",
  MONGODB_URI = "mongodb://127.0.0.1:27017/wellness",
  RESEND_API_KEY = "",
  FROM_EMAIL = "Bookings <no-reply@example.com>",
  ADMIN_TOKEN = ""
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
async function sendEmail(to, subject, html) {
  if (!resend) return;
  try { await resend.emails.send({ from: FROM_EMAIL, to, subject, html }); }
  catch(e){ console.error("Email send failed:", e?.message || e); }
}

const TIMEZONE = "America/Chicago";
const WEEKLY_HOURS = {
  1: { open: "07:00", close: "18:00" }, // Mon
  2: { open: "07:00", close: "12:00" }, // Tue
  3: { open: "07:00", close: "18:00" }, // Wed
  4: { open: "07:00", close: "12:00" }, // Thu
  5: { open: "07:00", close: "18:00" }, // Fri
  6: null, 0: null
};
const SERVICES = {
  sauna:    { name: "Infrared Sauna",                 duration: 15, price: 10 },
  hbot:     { name: "Mild Hyperbaric Oxygen Therapy", duration: 60, price: 75 },
  icebath:  { name: "Cold Plunge",                    duration: 10, price: 10 },
  redlight: { name: "Red Light Therapy",              duration: 15, price: 10 },
  hydrogen: { name: "Hydrogen Therapy",               duration: 20, price: 20 },
  lymph:    { name: "Lymph Vibe Plate",               duration: 15, price: 10 }
};
const BUFFERS = { sauna:0, hbot:30, icebath:0, redlight:5, hydrogen:5, lymph:5 };
const BUNDLES = [
  { id:"bundle_alt_cold_sauna", label:"Cold Plunge + Sauna Alternating Therapy", services:["icebath","sauna"], price:20, totalMinutes:30 },
  { id:"bundle_red_lymph",      label:"Red Light + Lymph Vibe Plate",            services:["redlight","lymph"], price:15, totalMinutes:15 },
  { id:"bundle_hbot_sauna",     label:"mHBOT + Sauna",                            services:["hbot","sauna"], price:80, totalMinutes:90 },
  { id:"bundle_hbot_sauna_cold",label:"mHBOT + Sauna + Ice Bath",                 services:["hbot","sauna","icebath"], price:85, totalMinutes:90 },
  { id:"bundle_premium_rejuv",  label:"Premium Rejuvenation Bundle",              services:["hbot","sauna","icebath","redlight"], price:95, totalMinutes:105 },
  { id:"bundle_platinum_rejuv", label:"Platinum Rejuvenation Bundle",             services:["hbot","sauna","icebath","redlight","hydrogen"], price:105, totalMinutes:120 }
];
const SLOT = 15;
const SAME_DAY_CUTOFF_MIN = 0;
const HOLD_TTL_MIN = 12;

/* =========================
   APP
   ========================= */
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

/* =========================
   MONGO
   ========================= */
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db();
const Users = db.collection("users");
const Bookings = db.collection("bookings");
const Holds = db.collection("holds");
const Pending = db.collection("pending");

await Bookings.createIndex({ service: 1, startISO: 1 });
await Holds.createIndex({ service: 1, startISO: 1 });
await Holds.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
await Pending.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });

/* =========================
   HELPERS
   ========================= */
function weekdayKey(date) { return new Date(date).getDay(); }
function toDay(dateStr, hhmm) {
  const [H,M]=hhmm.split(":").map(Number);
  let d=startOfDay(new Date(dateStr)); d=setHours(d,H); d=setMinutes(d,M); d=setSeconds(d,0); return d;
}
function businessWindowOn(dateISO) {
  const cfg = WEEKLY_HOURS[weekdayKey(dateISO)];
  if (!cfg) return null;
  return { open: toDay(dateISO, cfg.open), close: toDay(dateISO, cfg.close) };
}
function intervalWithBuffer(serviceKey, start) {
  const end = addMinutes(start, SERVICES[serviceKey].duration);
  const endWB = addMinutes(end, BUFFERS[serviceKey]||0);
  return { start, end, endWB };
}
async function overlapsMongo(serviceKey, start, endWB) {
  const existing = await Bookings.find({ service: serviceKey }).toArray();
  const hitBooking = existing.some(b=>{
    const buf = BUFFERS[b.service] || 0;
    const startB = parseISO(b.startISO);
    const endBWB = addMinutes(parseISO(b.endISO), buf);
    return areIntervalsOverlapping({start, end:endWB},{start:startB, end:endBWB},{inclusive:true});
  });
  if (hitBooking) return true;
  const now = new Date();
  const holds = await Holds.find({ service: serviceKey, expireAt: { $gt: now } }).toArray();
  const hitHold = holds.some(h=>{
    const s = parseISO(h.startISO);
    const e = parseISO(h.endISOWB);
    return areIntervalsOverlapping({start, end:endWB},{start:s, end:e},{inclusive:true});
  });
  return hitHold;
}
function withinHours(serviceKey, startISO) {
  const win = businessWindowOn(startISO);
  if (!win) return false;
  const { start, end } = intervalWithBuffer(serviceKey, parseISO(startISO));
  if (isBefore(start, win.open)) return false;
  if (isAfter(end, win.close)) return false;
  return true;
}
function sameDayCutoffOK(startISO){
  if (!SAME_DAY_CUTOFF_MIN) return true;
  const start = parseISO(startISO); const now=new Date();
  if (!isSameDay(start,now)) return true;
  return ((start-now)/60000) >= SAME_DAY_CUTOFF_MIN;
}
function userPriceFor(serviceKey, user) {
  if (serviceKey==="hbot" && user && (user.hbotCredits||0) > 0) return 60;
  return SERVICES[serviceKey].price;
}

/* =========================
   AUTH
   ========================= */
app.post("/api/login", async (req,res)=>{
  const { email, name } = req.body||{};
  if (!email) return res.status(400).json({ error:"email required" });
  let u = await Users.findOne({ email });
  if (!u) {
    u = { _id:nanoid(), email, name: name||"", hbotCredits: 0, createdAt: new Date() };
    await Users.insertOne(u);
  } else if (name && !u.name) {
    await Users.updateOne({ email }, { $set: { name } });
    u = await Users.findOne({ email });
  }
  res.cookie("user", email, { httpOnly:false }).json({ ok:true, user:u });
});
app.get("/api/me", async (req,res)=>{
  const email=req.cookies.user;
  const user = email ? await Users.findOne({ email }) : null;
  res.json({ user, stripePublic: STRIPE_PUBLIC_KEY });
});
app.post("/api/grant-hbot-pack", async (req,res)=>{
  const { email } = req.body||{};
  if (!email) return res.status(400).json({ error:"email required" });
  const u = await Users.findOne({ email });
  if (!u) return res.status(404).json({ error:"unknown email" });
  await Users.updateOne({ email }, { $inc: { hbotCredits: 10 } });
  const updated = await Users.findOne({ email });
  res.json({ ok:true, user: updated });
});

/* =========================
   META & AVAILABILITY
   ========================= */
app.get("/api/meta",(req,res)=>res.json({ timezone:TIMEZONE, services:SERVICES, bundles:BUNDLES, buffers:BUFFERS, slot:SLOT }));
app.get("/api/availability", async (req,res)=>{
  const { service, date } = req.query;
  if (!service || !SERVICES[service] || !date) return res.status(400).json({ error:"bad params" });
  const win = businessWindowOn(`${date}T00:00:00`);
  if (!win) return res.json({ service, date, slots: [] });
  const out = [];
  let cursor = win.open;
  const dur = SERVICES[service].duration;
  while (!isAfter(addMinutes(cursor, dur), win.close)) {
    const { start, end, endWB } = intervalWithBuffer(service, cursor);
    const conflict = await overlapsMongo(service, start, endWB);
    if (!conflict) {
      out.push({
        startISO: formatISO(start,{representation:"complete"}).slice(0,19),
        endISO:   formatISO(end,  {representation:"complete"}).slice(0,19)
      });
    }
    cursor = addMinutes(cursor, SLOT);
  }
  res.json({ service, date, slots: out });
});
app.post("/api/quote", async (req,res)=>{
  const email=req.cookies.user;
  const user = email ? await Users.findOne({ email }) : null;
  const { service } = req.body||{};
  if (!service || !SERVICES[service]) return res.status(400).json({ error:"unknown service" });
  res.json({ ok:true, service, price: userPriceFor(service, user) });
});

/* =========================
   SOFT HOLDS
   ========================= */
async function placeHoldSingle({ service, startISO, email, unitAmount }) {
  const start = parseISO(startISO);
  const { end, endWB } = intervalWithBuffer(service, start);
  if (!withinHours(service, startISO)) return { ok:false, error:"outside business hours" };
  if (!sameDayCutoffOK(startISO)) return { ok:false, error:"past cutoff for today" };
  if (await overlapsMongo(service, start, endWB)) return { ok:false, error:"slot currently unavailable" };
  const expireAt = addMinutes(new Date(), HOLD_TTL_MIN);
  const doc = {
    _id: nanoid(),
    type: "single",
    service, startISO: formatISO(start,{representation:"complete"}).slice(0,19),
    endISO: formatISO(end,{representation:"complete"}).slice(0,19),
    endISOWB: formatISO(endWB,{representation:"complete"}).slice(0,19),
    email: email || null,
    unitAmount,
    expireAt, createdAt: new Date()
  };
  await Holds.insertOne(doc);
  return { ok:true, holdId: doc._id };
}
async function placeHoldBundle({ bundleId, selections, email, amount }) {
  const expireAt = addMinutes(new Date(), HOLD_TTL_MIN);
  for (const sel of selections) {
    if (!withinHours(sel.service, sel.startISO)) return { ok:false, error:"outside hours" };
    if (!sameDayCutoffOK(sel.startISO)) return { ok:false, error:"past cutoff" };
    const start = parseISO(sel.startISO);
    const { endWB } = intervalWithBuffer(sel.service, start);
    if (await overlapsMongo(sel.service, start, endWB)) return { ok:false, error:"one or more slots unavailable" };
  }
  const groupId = nanoid();
  const docs = selections.map(sel=>{
    const start = parseISO(sel.startISO);
    const { end, endWB } = intervalWithBuffer(sel.service, start);
    return {
      _id: nanoid(),
      type: "bundle",
      groupId,
      bundleId,
      service: sel.service,
      startISO: formatISO(start,{representation:"complete"}).slice(0,19),
      endISO: formatISO(end,{representation:"complete"}).slice(0,19),
      endISOWB: formatISO(endWB,{representation:"complete"}).slice(0,19),
      email: email || null,
      amount,
      expireAt, createdAt: new Date()
    };
  });
  await Holds.insertMany(docs);
  return { ok:true, groupId };
}

/* =========================
   CHECKOUT
   ========================= */
app.post("/api/checkout-single", async (req,res)=>{
  const email=req.cookies.user;
  const user = email ? await Users.findOne({ email }) : null;
  const { service, startISO } = req.body||{};
  if (!service || !SERVICES[service] || !startISO) return res.status(400).json({ error:"missing service/startISO" });
  const unitAmount = userPriceFor(service, user) * 100;
  const hold = await placeHoldSingle({ service, startISO, email, unitAmount });
  if (!hold.ok) return res.status(409).json(hold);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: SERVICES[service].name },
        unit_amount: unitAmount
      },
      quantity: 1
    }],
    metadata: { kind:"single", service, startISO, holdId: hold.holdId },
    success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${req.protocol}://${req.get('host')}/cancel.html`
  });
  res.json({ ok:true, url: session.url });
});

app.post("/api/checkout-bundle", async (req,res)=>{
  const email=req.cookies.user;
  const { bundleId, selections } = req.body||{};
  const bundle = BUNDLES.find(b=>b.id===bundleId);
  if (!bundle) return res.status(400).json({ error:"invalid bundleId" });
  if (!Array.isArray(selections) || selections.length !== bundle.services.length) {
    return res.status(400).json({ error:"selections must match bundle services" });
  }
  const hold = await placeHoldBundle({ bundleId, selections, email, amount: bundle.price*100 });
  if (!hold.ok) return res.status(409).json(hold);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: bundle.label },
        unit_amount: bundle.price * 100
      },
      quantity: 1
    }],
    metadata: { kind:"bundle", bundleId, groupId: hold.groupId },
    success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${req.protocol}://${req.get('host')}/cancel.html`
  });
  res.json({ ok:true, url: session.url });
});

/* =========================
   CONFIRM
   ========================= */
app.post("/api/confirm", async (req,res)=>{
  const emailCookie=req.cookies.user || null;
  const { session_id } = req.body||{};
  if (!session_id) return res.status(400).json({ error:"missing session_id" });
  const session = await stripe.checkout.sessions.retrieve(session_id);
  if (!session || session.payment_status!=="paid") {
    return res.status(402).json({ error:"payment not completed" });
  }
  const meta = session.metadata || {};
  const kind = meta.kind;
  try {
    if (kind==="single") {
      const { service, startISO, holdId } = meta;
      const hold = await Holds.findOne({ _id: holdId });
      if (!hold) return res.status(409).json({ error:"hold expired; payment safe — please reschedule" });
      const start = parseISO(startISO);
      const { end } = intervalWithBuffer(service, start);
      const email = hold.email || emailCookie;
      if (service==="hbot" && email) {
        const user = await Users.findOne({ email });
        if (user && (user.hbotCredits||0) > 0 && (hold.unitAmount===6000)) {
          await Users.updateOne({ email }, { $inc: { hbotCredits: -1 } });
        }
      }
      await Bookings.insertOne({
        _id: nanoid(),
        service,
        startISO: formatISO(start,{representation:"complete"}).slice(0,19),
        endISO:   formatISO(end,  {representation:"complete"}).slice(0,19),
        clientEmail: email || null,
        paidSessionId: session.id,
        createdAt: new Date()
      });
      await Holds.deleteOne({ _id: holdId });
      if (email) {
        const svcName = SERVICES[service]?.name || service;
        await sendEmail(
          email, `Booking confirmed: ${svcName}`,
          `<h2>Thank you!</h2><p>Your ${svcName} is confirmed.</p>
           <p><b>When:</b> ${new Date(start).toLocaleString()}</p>
           <p><b>Duration:</b> ${SERVICES[service].duration} minutes</p>`
        );
      }
      return res.json({ ok:true, kind:"single" });
    } else if (kind==="bundle") {
      const { bundleId, groupId } = meta;
      const holds = await Holds.find({ groupId }).toArray();
      if (!holds.length) return res.status(409).json({ error:"bundle holds expired; payment safe — please contact us" });
      const email = holds[0].email || emailCookie || null;
      const batch = holds.map(h=>{
        const start = parseISO(h.startISO);
        const { end } = intervalWithBuffer(h.service, start);
        return {
          _id: nanoid(),
          groupId,
          service: h.service,
          startISO: formatISO(start,{representation:"complete"}).slice(0,19),
          endISO:   formatISO(end,  {representation:"complete"}).slice(0,19),
          clientEmail: email,
          paidSessionId: session.id,
          createdAt: new Date()
        };
      });
      if (batch.length) await Bookings.insertMany(batch);
      await Holds.deleteMany({ groupId });
      if (email) {
        const titles = batch.map(b => SERVICES[b.service]?.name || b.service).join(" + ");
        const times  = batch.map(b => `<li>${SERVICES[b.service]?.name || b.service}: ${new Date(b.startISO).toLocaleString()}</li>`).join("");
        await sendEmail(email, `Bundle confirmed: ${titles}`, `<h2>Thank you!</h2><ul>${times}</ul>`);
      }
      return res.json({ ok:true, kind:"bundle", bundleId });
    } else {
      return res.status(400).json({ error:"bad metadata" });
    }
  } catch (e) {
    return res.status(500).json({ error:"confirm failed", detail:String(e) });
  }
});

/* =========================
   CUSTOMER & ADMIN
   ========================= */
app.get("/api/my-bookings", async (req, res) => {
  const email = req.cookies.user;
  if (!email) return res.status(401).json({ error: "not logged in" });
  const list = await Bookings.find({ clientEmail: email }).sort({ startISO: -1 }).limit(200).toArray();
  res.json({ bookings: list });
});
app.post("/api/logout", (req,res) => {
  res.clearCookie("user"); res.json({ ok:true });
});

function requireAdmin(req, res, next) {
  const token = req.query.token || req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).send("Unauthorized");
  next();
}
app.get("/admin/api/overview", requireAdmin, async (req, res) => {
  const [users, bookings, holds] = await Promise.all([
    Users.countDocuments(),
    Bookings.countDocuments(),
    Holds.countDocuments({ expireAt: { $gt: new Date() } })
  ]);
  res.json({ users, bookings, activeHolds: holds });
});
app.get("/admin/api/bookings", requireAdmin, async (req, res) => {
  const list = await Bookings.find().sort({ startISO: 1 }).limit(500).toArray();
  res.json(list);
});
app.get("/admin/api/holds", requireAdmin, async (req, res) => {
  const list = await Holds.find({ expireAt: { $gt: new Date() } })
    .sort({ expireAt: 1 }).limit(500).toArray();
  res.json(list);
});

/* =========================
   DEBUG
   ========================= */
app.get("/api/bookings", async (req,res)=>{
  const docs = await Bookings.find().sort({ startISO:1 }).toArray();
  res.json({ bookings: docs });
});
app.get("/api/users", async (req,res)=>{
  const docs = await Users.find().toArray();
  res.json({ users: docs });
});

/* =========================
   START
   ========================= */
app.listen(PORT, ()=>console.log(`DetoxEdge running on port ${PORT}`));
