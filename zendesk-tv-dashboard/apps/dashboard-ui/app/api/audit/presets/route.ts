import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

interface AuditPreset {
  id: string;
  name: string;
  agentId: string;
  search: string;
  updatedAt: string;
}

const presetsFilePath = path.resolve(process.cwd(), "data/audit-filter-presets.json");

function normalizePreset(value: unknown): AuditPreset | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AuditPreset>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const agentId = typeof candidate.agentId === "string" ? candidate.agentId.trim() : "all";
  const search = typeof candidate.search === "string" ? candidate.search.trim() : "";
  const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt.trim() : "";

  if (!id || !name || !updatedAt) {
    return null;
  }

  return { id, name, agentId: agentId || "all", search, updatedAt };
}

async function readPresets(): Promise<AuditPreset[]> {
  try {
    const raw = await fs.readFile(presetsFilePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => normalizePreset(item)).filter((item): item is AuditPreset => item !== null);
  } catch {
    return [];
  }
}

async function writePresets(presets: AuditPreset[]): Promise<void> {
  await fs.mkdir(path.dirname(presetsFilePath), { recursive: true });
  await fs.writeFile(presetsFilePath, JSON.stringify(presets, null, 2), "utf-8");
}

export async function GET(): Promise<NextResponse> {
  const presets = await readPresets();
  return NextResponse.json(
    { presets },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { name?: string; agentId?: string; search?: string };
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Preset name is required." }, { status: 400 });
  }

  const presets = await readPresets();
  const nowIso = new Date().toISOString();
  const existing = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.agentId = body.agentId?.trim() || "all";
    existing.search = body.search?.trim() || "";
    existing.updatedAt = nowIso;
  } else {
    presets.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      agentId: body.agentId?.trim() || "all",
      search: body.search?.trim() || "",
      updatedAt: nowIso
    });
  }

  await writePresets(presets);
  return NextResponse.json({ presets });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Preset id is required." }, { status: 400 });
  }

  const presets = await readPresets();
  const nextPresets = presets.filter((preset) => preset.id !== id);
  await writePresets(nextPresets);
  return NextResponse.json({ presets: nextPresets });
}
