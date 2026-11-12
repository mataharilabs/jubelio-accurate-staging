import { NextResponse } from "next/server";
import { readWeightWorkbook } from "@/lib/cleanup/read-xlsx";
import { getStore } from "@/lib/db";
import { bundlesFromLegacyWeights, groupBundles, weightTotalError } from "@/lib/domain/bundle-weight";
import { AppError } from "@/lib/errors";
import { fail, requirePermission } from "@/lib/http";
import { listProducts } from "@/lib/products/service";

export async function GET() {
  try {
    await requirePermission("weights.manage");
    const store = await getStore();
    const [components, reviews] = await Promise.all([
      store.listBundleComponents().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        if (/0011_product_names_bundle_weights/i.test(message)) return [];
        throw error;
      }),
      store.listReviews(),
    ]);
    return NextResponse.json({
      bundles: groupBundles(components),
      reviews: reviews.filter((row) => row.kind === "bobot" && row.status === "open"),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    await requirePermission("weights.manage");
    const store = await getStore();
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError("Pilih berkas bobot.");
      const parsed = readWeightWorkbook(Buffer.from(await file.arrayBuffer()));
      const replace = form.get("replace") === "1";
      const count = await store.upsertWeights(parsed, replace);
      const products = await listProducts({ active: "all" }).catch(() => []);
      const bundles = bundlesFromLegacyWeights(parsed, products.map((row) => row.sku));
      if (replace) await store.clearBundleComponents();
      for (const bundle of bundles) {
        if (bundle.components.length === 1 && bundle.components[0]?.sku === bundle.bundleSku) continue;
        await store.saveBundle(bundle.bundleSku, bundle.components);
      }
      return NextResponse.json({ count });
    }
    const body = (await request.json()) as {
      id?: string;
      bundleKey?: string;
      bobot?: number;
      deleteId?: string;
      deleteBundle?: string;
      bundleSku?: string;
      components?: { sku: string; qty: number; weightPct: number }[];
    };
    if (body.deleteBundle) {
      await store.deleteBundle(body.deleteBundle);
      return NextResponse.json({ ok: true });
    }
    if (body.deleteId) {
      await store.deleteWeight(body.deleteId);
      return NextResponse.json({ ok: true });
    }
    if (body.bundleSku || body.components) {
      const components = (body.components ?? []).map((row) => ({
        sku: row.sku.trim(),
        qty: Number(row.qty),
        weightPct: Number(row.weightPct),
      }));
      const error = weightTotalError(components);
      if (!body.bundleSku?.trim()) throw new AppError("SKU paket wajib diisi.");
      if (error) throw new AppError(error);
      await store.saveBundle(body.bundleSku, components);
      return NextResponse.json({ ok: true });
    }
    if (body.id) {
      const weight = await store.updateWeight(body.id, { bundleKey: body.bundleKey, bobot: body.bobot });
      return NextResponse.json(weight);
    }
    if (!body.bundleKey || body.bobot == null) throw new AppError("Kunci dan bobot wajib diisi.");
    await store.upsertWeights([{ bundleKey: body.bundleKey, bobot: Number(body.bobot) }], false);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
