import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Contributions } from "@supabase/middleware";
import { withRequiredClaims } from "@supabase/server/middleware/required-claims";
import { withSupabaseClient } from "@supabase/server/middleware/client";
import { toNestGuard } from "./lib/supabase.guard.js";

// Sample data: breaking-app's controller after moving off the NestJS adapter.
// The bare withSupabase() was auth: 'user', so the guard gets withRequiredClaims().
const entries = [withRequiredClaims(), withSupabaseClient()] as const;
const SupabaseGuard = toNestGuard(entries);

@Controller("games")
@UseGuards(SupabaseGuard)
export class GamesController {
  @Get()
  async list(@Req() req: Contributions<typeof entries>) {
    const { data } = await req.supabase.from("favorite_games").select();
    return data;
  }
}
