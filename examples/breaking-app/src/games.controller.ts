import { Controller, Get, UseGuards } from "@nestjs/common";
import { SupabaseCtx, withSupabase } from "@supabase/server/adapters/nestjs";
import type { SupabaseContext } from "@supabase/server";

// Sample data: a made-up NestJS controller on the deprecated adapter. A bare withSupabase() means auth: 'user'.
@Controller("games")
@UseGuards(withSupabase())
export class GamesController {
  @Get()
  async list(@SupabaseCtx() ctx: SupabaseContext) {
    const { data } = await ctx.supabase.from("favorite_games").select();
    return data;
  }
}
