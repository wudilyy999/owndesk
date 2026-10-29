import { requireOwner, requireSameOrigin } from "@/lib/auth"
import {
  describeSetting,
  setSettings,
  settingKeys,
  settingUpdatesSchema,
  type SettingKey,
} from "@/lib/config"
import { errorResponse } from "@/lib/errors"
export async function GET(request: Request) {
  try {
    await requireOwner(request.headers)
    return Response.json(await Promise.all(settingKeys.map(describeSetting)), {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const updates = settingUpdatesSchema.parse(await request.json())
    await setSettings(updates as { key: SettingKey; value: string | null }[])
    return Response.json(
      await Promise.all(
        updates.map((update) => describeSetting(update.key as SettingKey))
      ),
      { headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
