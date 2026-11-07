import { createClient } from "@supabase/supabase-js";
import { stripe } from "@/lib/stripe";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const userId = event.data.object.client_reference_id;
    if (userId) await admin.from("profiles").update({ plan: "pro" }).eq("id", userId);
  }

  return Response.json({ received: true });
}
