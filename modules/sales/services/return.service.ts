import { ReturnRepository } from "../repositories/return.repository.js";
import { CreateReturnDTO, UpdateReturnDTO } from "../dto/return.dto.js";
import { ERPCache, ERPEventBus, erpPool } from "../../../server-erp-core.js";
import { moveStock } from "../../warehouses/services/inventory.service.js";
import { CustomerService } from "../../customers/services/customer.service.js";
import { SafeService } from "../../accounting/services/safe.service.js";
import { postReturnEntry } from "../../accounts/services/auto-posting.service.js";
import { toDateOnly } from "../../common/dateOnly.js";

const LIST_CACHE_KEY = "sales:returns:all";

export class ReturnService {
  private repository: ReturnRepository;
  private customerService: CustomerService;
  private safeService: SafeService;

  constructor() {
    this.repository = new ReturnRepository();
    this.customerService = new CustomerService();
    this.safeService = new SafeService();
  }

  async getReturns(): Promise<any[]> {
    const cached = ERPCache.get(LIST_CACHE_KEY);
    if (cached) return cached;

    const returns = await this.repository.getAll();
    ERPCache.set(LIST_CACHE_KEY, returns, 60);
    return returns;
  }

  async getReturnById(id: number): Promise<any> {
    const returnDoc = await this.repository.getById(id);
    if (!returnDoc) {
      const err: any = new Error("Sales return not found");
      err.statusCode = 404;
      throw err;
    }
    return returnDoc;
  }

  /**
   * Fetches all sales invoices eligible for return, calculating line-by-line
   * previously returned quantities and remaining returnable quantities.
   */
  async getEligibleInvoices(options?: { branchId?: number; includeInvoiceId?: number | string }): Promise<any[]> {
    let sql = `
      SELECT i.id, i.invoice_no, i.customer_id, i.customer_name, i.date, i.due_date,
             i.status, i.is_posted, i.warehouse, i.warehouse_id, i.branch_id,
             i.sales_rep, i.subtotal, i.discount_total, i.tax_total, i.net_amount, i.paid_amount,
             i.created_at
        FROM sales_invoices i
       WHERE (
         i.status NOT IN ('ملغاة', 'cancelled', 'ملغى', 'draft', 'مسودة')
         OR i.is_posted = true
       )
    `;
    const params: any[] = [];
    if (options?.branchId) {
      params.push(options.branchId);
      sql += ` AND (i.branch_id = $${params.length} OR i.branch_id IS NULL)`;
    }
    sql += ` ORDER BY i.id DESC`;

    const invoicesRes = await erpPool.query(sql, params);
    const invoices = invoicesRes.rows;
    if (invoices.length === 0) return [];

    const invoiceIds = invoices.map((inv: any) => inv.id);

    const itemsRes = await erpPool.query(
      `SELECT id, invoice_id, item_id, item_type, ingredient_id, product_id,
              barcode, code, name, unit, qty, price, unit_cost, total_cost,
              discount_percent, vat_percent, total
         FROM sales_invoice_items
        WHERE invoice_id = ANY($1::int[])
        ORDER BY id ASC`,
      [invoiceIds]
    );
    const itemsByInvoiceId = new Map<number, any[]>();
    for (const row of itemsRes.rows) {
      const arr = itemsByInvoiceId.get(row.invoice_id) || [];
      arr.push(row);
      itemsByInvoiceId.set(row.invoice_id, arr);
    }

    const returnsRes = await erpPool.query(
      `SELECT sri.id, sri.return_id, sri.invoice_item_id, sri.item_code, sri.item_name,
              sri.ingredient_id, sri.product_id, sri.qty_returned,
              sr.invoice_id, sr.status as return_status
         FROM sales_return_items sri
         JOIN sales_returns sr ON sri.return_id = sr.id
        WHERE sr.status NOT IN ('ملغى', 'ملغاة', 'cancelled')
        ORDER BY sri.id ASC`
    );
    const returnItems = returnsRes.rows;

    const includeInvStr = options?.includeInvoiceId ? String(options.includeInvoiceId).trim().toLowerCase() : null;
    const eligibleInvoices: any[] = [];

    for (const inv of invoices) {
      const invItems = itemsByInvoiceId.get(inv.id) || [];
      if (invItems.length === 0) continue;

      const invIdStr = String(inv.id);
      const invNoStr = String(inv.invoice_no || "").toLowerCase();
      const linkedReturnItems = returnItems.filter((ri: any) => {
        const raw = String(ri.invoice_id || "").trim().toLowerCase();
        const stripped = raw.replace(/^inv-0*/i, "");
        return (
          raw === invIdStr ||
          stripped === invIdStr ||
          raw === `inv-${invIdStr}` ||
          (invNoStr && raw === invNoStr)
        );
      });

      const matchedReturnIds = new Set<number>();
      let totalQtyInvoiced = 0;
      let totalQtyPreviouslyReturned = 0;
      let totalQtyRemaining = 0;

      const enrichedItems = invItems.map((line: any) => {
        const lineQty = Number(line.qty) || 0;
        totalQtyInvoiced += lineQty;

        let returnedForThisLine = 0;
        for (const ri of linkedReturnItems) {
          if (matchedReturnIds.has(ri.id)) continue;

          let matches = false;
          if (ri.invoice_item_id && Number(ri.invoice_item_id) === Number(line.id)) {
            matches = true;
          } else if (!ri.invoice_item_id) {
            if (line.code && ri.item_code && String(line.code).trim().toLowerCase() === String(ri.item_code).trim().toLowerCase()) {
              matches = true;
            } else if (line.name && ri.item_name && String(line.name).trim().toLowerCase() === String(ri.item_name).trim().toLowerCase()) {
              matches = true;
            } else if (line.ingredient_id && ri.ingredient_id && Number(line.ingredient_id) === Number(ri.ingredient_id)) {
              matches = true;
            } else if (line.product_id && ri.product_id && Number(line.product_id) === Number(ri.product_id)) {
              matches = true;
            }
          }

          if (matches) {
            matchedReturnIds.add(ri.id);
            returnedForThisLine += Number(ri.qty_returned) || 0;
          }
        }

        totalQtyPreviouslyReturned += returnedForThisLine;
        const lineRemaining = Math.max(0, lineQty - returnedForThisLine);
        totalQtyRemaining += lineRemaining;

        return {
          id: line.id,
          invoiceItemId: line.id,
          itemId: line.item_id,
          itemType: line.item_type,
          ingredientId: line.ingredient_id,
          productId: line.product_id,
          barcode: line.barcode,
          code: line.code,
          name: line.name,
          unit: line.unit || "قطعة",
          qtyInvoiced: lineQty,
          qtyPreviouslyReturned: returnedForThisLine,
          remainingQty: lineRemaining,
          price: Number(line.price) || 0,
          unitCost: Number(line.unit_cost) || 0,
          totalCost: Number(line.total_cost) || 0,
          discountPercent: Number(line.discount_percent) || 0,
          vatPercent: Number(line.vat_percent) || 0,
          total: Number(line.total) || 0,
        };
      });

      const isCurrentIncluded = includeInvStr && (
        String(inv.id) === includeInvStr ||
        String(inv.invoice_no).toLowerCase() === includeInvStr ||
        `inv-${inv.id}` === includeInvStr
      );

      if (totalQtyRemaining <= 0 && !isCurrentIncluded) {
        continue;
      }

      eligibleInvoices.push({
        id: inv.id,
        invoiceNo: inv.invoice_no,
        customerId: inv.customer_id,
        customerName: inv.customer_name,
        date: toDateOnly(inv.date),
        dueDate: toDateOnly(inv.due_date),
        status: inv.status,
        isPosted: Boolean(inv.is_posted),
        warehouse: inv.warehouse || "المخزن الرئيسي",
        warehouseId: inv.warehouse_id || 1,
        branchId: inv.branch_id || 1,
        salesRep: inv.sales_rep,
        subtotal: Number(inv.subtotal) || 0,
        discountTotal: Number(inv.discount_total) || 0,
        taxTotal: Number(inv.tax_total) || 0,
        netAmount: Number(inv.net_amount) || 0,
        paidAmount: Number(inv.paid_amount) || 0,
        totalQtyInvoiced,
        totalQtyPreviouslyReturned,
        totalQtyRemaining,
        returnableItemsCount: enrichedItems.filter((i: any) => i.remainingQty > 0).length,
        totalItemsCount: enrichedItems.length,
        items: enrichedItems
      });
    }

    return eligibleInvoices;
  }

  /**
   * Fetches full returnable details for a single invoice including remaining quantities per line item.
   */
  async getInvoiceReturnDetails(invId: string | number): Promise<any> {
    const rawInvId = String(invId).trim();
    const strippedInvId = rawInvId.replace(/^INV-0*/i, "");

    const invoiceRes = await erpPool.query(
      `SELECT i.*
         FROM sales_invoices i
        WHERE i.id::text = $1
           OR i.id::text = $2
           OR i.invoice_no ILIKE $1
           OR i.invoice_no ILIKE $2
           OR REPLACE(UPPER(i.invoice_no), 'INV-', '') = $2
        ORDER BY CASE WHEN i.id::text = $2 THEN 0 WHEN i.invoice_no ILIKE $1 THEN 1 ELSE 2 END
        LIMIT 1`,
      [rawInvId, strippedInvId]
    );

    if (invoiceRes.rows.length === 0) {
      const err: any = new Error("فاتورة المبيعات الأصلية غير موجودة");
      err.statusCode = 404;
      throw err;
    }

    const inv = invoiceRes.rows[0];

    const linesRes = await erpPool.query(
      `SELECT id, invoice_id, item_id, item_type, ingredient_id, product_id,
              barcode, code, name, unit, qty, price, unit_cost, total_cost,
              discount_percent, vat_percent, total
         FROM sales_invoice_items
        WHERE invoice_id = $1
        ORDER BY id ASC`,
      [inv.id]
    );
    const invoiceLines = linesRes.rows;

    const returnsRes = await erpPool.query(
      `SELECT sri.id, sri.return_id, sri.invoice_item_id, sri.item_code, sri.item_name,
              sri.ingredient_id, sri.product_id, sri.qty_returned,
              sr.invoice_id, sr.return_no, sr.date, sr.status as return_status
         FROM sales_return_items sri
         JOIN sales_returns sr ON sri.return_id = sr.id
        WHERE (
          sr.invoice_id = $1::text
          OR sr.invoice_id = ('INV-' || $1::text)
          OR sr.invoice_id = $2
          OR REPLACE(UPPER(sr.invoice_id), 'INV-', '') = $3
        )
        AND sr.status NOT IN ('ملغى', 'ملغاة', 'cancelled')
        ORDER BY sri.id ASC`,
      [String(inv.id), inv.invoice_no, String(inv.id)]
    );
    const returnItems = returnsRes.rows;

    const matchedReturnIds = new Set<number>();
    let totalQtyInvoiced = 0;
    let totalQtyPreviouslyReturned = 0;
    let totalQtyRemaining = 0;

    const enrichedItems = invoiceLines.map((line: any) => {
      const lineQty = Number(line.qty) || 0;
      totalQtyInvoiced += lineQty;

      let returnedForThisLine = 0;
      for (const ri of returnItems) {
        if (matchedReturnIds.has(ri.id)) continue;

        let matches = false;
        if (ri.invoice_item_id && Number(ri.invoice_item_id) === Number(line.id)) {
          matches = true;
        } else if (!ri.invoice_item_id) {
          if (line.code && ri.item_code && String(line.code).trim().toLowerCase() === String(ri.item_code).trim().toLowerCase()) {
            matches = true;
          } else if (line.name && ri.item_name && String(line.name).trim().toLowerCase() === String(ri.item_name).trim().toLowerCase()) {
            matches = true;
          } else if (line.ingredient_id && ri.ingredient_id && Number(line.ingredient_id) === Number(ri.ingredient_id)) {
            matches = true;
          } else if (line.product_id && ri.product_id && Number(line.product_id) === Number(ri.product_id)) {
            matches = true;
          }
        }

        if (matches) {
          matchedReturnIds.add(ri.id);
          returnedForThisLine += Number(ri.qty_returned) || 0;
        }
      }

      totalQtyPreviouslyReturned += returnedForThisLine;
      const lineRemaining = Math.max(0, lineQty - returnedForThisLine);
      totalQtyRemaining += lineRemaining;

      return {
        id: line.id,
        invoiceItemId: line.id,
        itemId: line.item_id,
        itemType: line.item_type,
        ingredientId: line.ingredient_id,
        productId: line.product_id,
        barcode: line.barcode,
        itemCode: line.code || "ITEM",
        code: line.code || "ITEM",
        itemName: line.name || "صنف",
        name: line.name || "صنف",
        unit: line.unit || "قطعة",
        qtyInvoiced: lineQty,
        qtyPreviouslyReturned: returnedForThisLine,
        remainingQty: lineRemaining,
        qtyReturned: lineRemaining,
        price: Number(line.price) || 0,
        unitCost: Number(line.unit_cost) || 0,
        totalCost: Number(line.total_cost) || 0,
        discountPercent: Number(line.discount_percent) || 0,
        vatPercent: Number(line.vat_percent) || 0,
        total: Number(line.total) || 0,
      };
    });

    return {
      invoice: {
        id: inv.id,
        invoiceNo: inv.invoice_no,
        customerId: inv.customer_id,
        customerName: inv.customer_name,
        date: toDateOnly(inv.date),
        dueDate: toDateOnly(inv.due_date),
        status: inv.status,
        isPosted: Boolean(inv.is_posted),
        warehouse: inv.warehouse || "المخزن الرئيسي",
        warehouseId: inv.warehouse_id || 1,
        branchId: inv.branch_id || 1,
        salesRep: inv.sales_rep || "",
        subtotal: Number(inv.subtotal) || 0,
        discountTotal: Number(inv.discount_total) || 0,
        taxTotal: Number(inv.tax_total) || 0,
        netAmount: Number(inv.net_amount) || 0,
        paidAmount: Number(inv.paid_amount) || 0,
      },
      items: enrichedItems,
      summary: {
        totalQtyInvoiced,
        totalQtyPreviouslyReturned,
        totalQtyRemaining,
        isFullyReturned: totalQtyRemaining <= 0,
      }
    };
  }

  /**
   * Creates a sales return and fully integrates it with:
   * 1. Warehouses: restocks items back into the inventory
   * 2. Customers: adjusts balance (credit note) or refunds cash
   * 3. Treasury / Safe: withdraws cash if cash refund
   * 4. Accounting: double-entry GL auto-posting for sales returns
   */
  async createReturn(dto: CreateReturnDTO): Promise<any> {
    const integrationWarnings: string[] = [];
    const client = await erpPool.connect();
    let returnDoc: any;
    let totalCost = 0;
    let warehouseId = Number(dto.warehouseId) || 1;
    try {
      await client.query("BEGIN");

      let sourceInvoice: any = null;
      let sourceInvoiceItems: any[] = [];
      let priorReturnItems: any[] = [];

      if (dto.invoiceId) {
        const rawInvId = String(dto.invoiceId).trim();
        const strippedInvId = rawInvId.replace(/^INV-0*/i, "");
        const sourceInvoiceRes = await client.query(
          `SELECT * FROM sales_invoices
            WHERE id::text = $1
               OR id::text = $2
               OR invoice_no ILIKE $1
               OR invoice_no ILIKE $2
               OR REPLACE(UPPER(invoice_no), 'INV-', '') = $2
            ORDER BY CASE WHEN id::text = $2 THEN 0 WHEN invoice_no ILIKE $1 THEN 1 ELSE 2 END
            LIMIT 1`,
          [rawInvId, strippedInvId]
        );
        if (sourceInvoiceRes.rows.length > 0) {
          sourceInvoice = sourceInvoiceRes.rows[0];
          const sourceLines = await client.query(
            `SELECT id, ingredient_id, product_id, code, name, unit_cost, qty, price, discount_percent, vat_percent
               FROM sales_invoice_items WHERE invoice_id = $1 ORDER BY id`,
            [sourceInvoice.id]
          );
          sourceInvoiceItems = sourceLines.rows;

          const priorReturnsRes = await client.query(
            `SELECT sri.id, sri.invoice_item_id, sri.item_code, sri.item_name, sri.ingredient_id, sri.product_id, sri.qty_returned
               FROM sales_return_items sri
               JOIN sales_returns sr ON sri.return_id = sr.id
              WHERE (sr.invoice_id = $1::text OR sr.invoice_id = ('INV-' || $1::text) OR sr.invoice_id = $2)
                AND sr.status NOT IN ('ملغى', 'ملغاة', 'cancelled')
              ORDER BY sri.id ASC`,
            [String(sourceInvoice.id), sourceInvoice.invoice_no]
          );
          priorReturnItems = priorReturnsRes.rows;
        }
      }

      if (!dto.warehouseId && sourceInvoice?.warehouse_id) {
        warehouseId = Number(sourceInvoice.warehouse_id);
      } else if (!dto.warehouseId && dto.warehouse) {
        const warehouse = await client.query(
          "SELECT id FROM warehouses WHERE name ILIKE $1 OR id::text = $1 LIMIT 1",
          [dto.warehouse]
        );
        if (warehouse.rows.length) warehouseId = Number(warehouse.rows[0].id);
      }

      const matchedPriorItemIds = new Set<number>();
      const costedItems = [];

      for (const item of dto.items || []) {
        const qty = Number(item.qtyReturned) || 0;
        if (qty <= 0) throw new Error(`كمية المرتجع غير صحيحة للصنف "${item.itemName}"`);

        const sourceItem = sourceInvoiceItems.find((line: any) =>
          (item.invoiceItemId && Number(line.id) === Number(item.invoiceItemId)) ||
          (item.ingredientId && Number(line.ingredient_id) === Number(item.ingredientId)) ||
          (item.productId && Number(line.product_id) === Number(item.productId)) ||
          (item.itemCode && line.code && String(line.code).trim().toLowerCase() === String(item.itemCode).trim().toLowerCase()) ||
          (item.itemName && line.name && String(line.name).trim().toLowerCase() === String(item.itemName).trim().toLowerCase())
        );

        if (sourceItem) {
          let previouslyReturned = 0;
          for (const pri of priorReturnItems) {
            if (matchedPriorItemIds.has(pri.id)) continue;
            let m = false;
            if (pri.invoice_item_id && Number(pri.invoice_item_id) === Number(sourceItem.id)) {
              m = true;
            } else if (!pri.invoice_item_id) {
              if (sourceItem.code && pri.item_code && String(sourceItem.code).trim().toLowerCase() === String(pri.item_code).trim().toLowerCase()) {
                m = true;
              } else if (sourceItem.name && pri.item_name && String(sourceItem.name).trim().toLowerCase() === String(pri.item_name).trim().toLowerCase()) {
                m = true;
              } else if (sourceItem.ingredient_id && pri.ingredient_id && Number(sourceItem.ingredient_id) === Number(pri.ingredient_id)) {
                m = true;
              } else if (sourceItem.product_id && pri.product_id && Number(sourceItem.product_id) === Number(pri.product_id)) {
                m = true;
              }
            }
            if (m) {
              matchedPriorItemIds.add(pri.id);
              previouslyReturned += Number(pri.qty_returned) || 0;
            }
          }

          const originalQty = Number(sourceItem.qty) || 0;
          const remainingQty = Math.max(0, originalQty - previouslyReturned);
          if (qty > remainingQty + 0.0001) {
            throw new Error(`لا يمكن إرجاع كمية (${qty}) تتجاوز الكمية المتبقية القابلة للإرجاع (${remainingQty}) للصنف "${item.itemName}" (الكمية الأصلية: ${originalQty}، المرتجع سابقاً: ${previouslyReturned})`);
          }
        }

        let invoiceItemId = Number(item.invoiceItemId || sourceItem?.id) || null;
        let productId = Number(item.productId || sourceItem?.product_id) || null;
        let ingredientId = Number(item.ingredientId || sourceItem?.ingredient_id) || null;

        if (!ingredientId) {
          const ingredient = await client.query(
            `SELECT id FROM ingredients
              WHERE (code = $1 AND $1 <> '') OR name ILIKE $2
              ORDER BY CASE WHEN code = $1 THEN 0 ELSE 1 END
              LIMIT 1`,
            [item.itemCode || "", item.itemName || ""]
          );
          ingredientId = Number(ingredient.rows[0]?.id) || null;
        }

        let unitCost = Number(sourceItem?.unit_cost) || 0;
        if (!unitCost && ingredientId) {
          const stock = await client.query(
            `SELECT avg_cost, unit_cost, last_cost, cost
               FROM inventory_items
              WHERE warehouse_id = $1 AND ingredient_id = $2
              ORDER BY id
              LIMIT 1
              FOR UPDATE`,
            [warehouseId, ingredientId]
          );
          const stockRow = stock.rows[0];
          unitCost = [
            stockRow?.avg_cost,
            stockRow?.unit_cost,
            stockRow?.last_cost,
            stockRow?.cost,
          ].map((value) => Number(value) || 0).find((value) => value > 0) || 0;
          if (!unitCost) {
            const ingredient = await client.query(
              "SELECT avg_cost, cost_price, last_purchase_price, cost FROM ingredients WHERE id = $1",
              [ingredientId]
            );
            const ingredientRow = ingredient.rows[0];
            unitCost = [
              ingredientRow?.avg_cost,
              ingredientRow?.cost_price,
              ingredientRow?.last_purchase_price,
              ingredientRow?.cost,
            ].map((value) => Number(value) || 0).find((value) => value > 0) || 0;
          }
        }

        if (!ingredientId) unitCost = 0;
        const totalItemCost = qty * unitCost;
        totalCost += totalItemCost;
        costedItems.push({
          ...item,
          invoiceItemId,
          productId,
          ingredientId,
          unitCost,
          totalCost: totalItemCost
        });
      }

      const computedItemsTotal = costedItems.reduce(
        (sum, it) => sum + (Number(it.total) || (Number(it.qtyReturned || 0) * Number(it.price || 0))),
        0
      );
      const itemsTotal = Number(dto.itemsTotal) > 0 ? Number(dto.itemsTotal) : computedItemsTotal;
      const taxTotal = Number(dto.taxTotal) || 0;
      const discountTotal = Number(dto.discountTotal) || 0;
      const expenses = Number(dto.expenses) || 0;
      const computedGrandTotal = Math.max(0, itemsTotal + taxTotal - discountTotal + expenses);
      const grandTotal = Number(dto.grandTotal) > 0 ? Number(dto.grandTotal) : computedGrandTotal;

      const customerId = dto.customerId || Number(sourceInvoice?.customer_id) || null;
      const branchId = dto.branchId || Number(sourceInvoice?.branch_id) || 1;

      returnDoc = await this.repository.create({
        ...dto,
        invoiceId: sourceInvoice ? String(sourceInvoice.id) : (dto.invoiceId || null),
        customerId,
        warehouseId,
        branchId,
        itemsTotal,
        taxTotal,
        discountTotal,
        expenses,
        grandTotal,
        totalCost,
        items: costedItems
      }, client);

      let movementTotalCost = 0;
      for (let index = 0; index < costedItems.length; index++) {
        const item = costedItems[index];
        if (!item.ingredientId) continue;
        const movement = await moveStock(client, {
          warehouse_id: warehouseId,
          ingredient_id: item.ingredientId,
          delta: Number(item.qtyReturned),
          ref_type: "sales_return",
          ref_id: Number(returnDoc.id),
          unit_cost: Number(item.unitCost) > 0 ? Number(item.unitCost) : undefined,
          user: dto.salesRep || "sales_module",
          notes: `مرتجع مبيعات ${returnDoc.return_no || returnDoc.id} — ${item.itemName}`
        });
        item.unitCost = Number(movement.unit_cost) || 0;
        item.totalCost = Number(movement.total_cost) || 0;
        movementTotalCost += item.totalCost;
      }
      totalCost = movementTotalCost;

      const returnItemIds = await client.query(
        "SELECT id FROM sales_return_items WHERE return_id = $1 ORDER BY id",
        [returnDoc.id]
      );
      for (let index = 0; index < costedItems.length; index++) {
        const itemId = returnItemIds.rows[index]?.id;
        if (!itemId) continue;
        await client.query(
          "UPDATE sales_return_items SET unit_cost = $1, total_cost = $2 WHERE id = $3",
          [costedItems[index].unitCost, costedItems[index].totalCost, itemId]
        );
      }

      const journalEntry = await postReturnEntry({
        id: Number(returnDoc.id),
        grand_total: grandTotal,
        refund_method: dto.refundMethod || "إشعار دائن للعميل",
        customer_name: dto.customerName,
        items_total: itemsTotal,
        tax_total: taxTotal,
        discount_total: discountTotal,
        expenses,
        total_cost: totalCost,
        branch_id: returnDoc.branch_id || dto.branchId || 1
      }, client);
      if ((grandTotal > 0 || totalCost > 0) && !journalEntry?.id) {
        throw new Error(`تعذر إنشاء قيد مرتجع المبيعات #${returnDoc.return_no || returnDoc.id}`);
      }
      await client.query(
        "UPDATE sales_returns SET total_cost = $1, journal_entry_id = $2 WHERE id = $3",
        [totalCost, journalEntry?.id || null, returnDoc.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    ERPCache.delete(LIST_CACHE_KEY);
    ERPCache.delete("sales:invoices:all");
    returnDoc = await this.repository.getById(Number(returnDoc.id));

    const grandTotal = parseFloat(returnDoc.grandTotal || 0);

    // 2) Customer balance & transactions
    let customerId = dto.customerId;
    if (!customerId && dto.customerName) {
      try {
        const custRes = await erpPool.query("SELECT id FROM customers WHERE name ILIKE $1 LIMIT 1", [dto.customerName]);
        if (custRes.rows.length > 0) {
          customerId = custRes.rows[0].id;
        }
      } catch (_) {}
    }

    const isCreditRefund = (dto.refundMethod || "إشعار دائن للعميل") === "إشعار دائن للعميل" || (dto.refundMethod || "").includes("دائن") || (dto.refundMethod || "").includes("حساب");

    if (customerId && isCreditRefund) {
      try {
        await this.customerService.recordTransaction({
          customer_id: customerId,
          amount: grandTotal,
          type: "payment", // payment credits customer balance (reduces debt)
          notes: `إشعار دائن مرتجع مبيعات ${returnDoc.return_no || returnDoc.returnNo}`
        });
      } catch (e: any) {
        integrationWarnings.push(`تعذر تخفيض رصيد العميل بالمرتجع: ${e.message}`);
      }
    }

    // 3) Treasury / Safe: If cash refund, record cash withdrawal from safe
    if (!isCreditRefund && grandTotal > 0) {
      try {
        const safes = await this.safeService.getSafes();
        const targetSafe = safes.length > 0 ? safes[0] : null;
        if (targetSafe) {
          await this.safeService.adjustSafeBalance(targetSafe.id, {
            amount: grandTotal,
            type: "out",
            notes: `صرف مردود مبيعات نقدي ${returnDoc.return_no || returnDoc.returnNo} — ${dto.customerName}`
          });
        }
      } catch (e: any) {
        console.warn("Could not record safe withdrawal for return:", e.message);
      }
    }

    ERPEventBus.getInstance().emitEvent("SalesReturnCreated", {
      returnId: returnDoc.id,
      returnNo: returnDoc.return_no || returnDoc.returnNo,
      customerName: returnDoc.customer_name || returnDoc.customerName,
      grandTotal,
      timestamp: new Date()
    });

    return { ...returnDoc, totalCost, integrationWarnings };
  }

  async updateReturn(id: number, dto: UpdateReturnDTO): Promise<any> {
    const found = await this.repository.getById(id);
    if (!found) {
      const err: any = new Error("Return not found");
      err.statusCode = 404;
      throw err;
    }

    if (found.status === "تم التأكيد والمحاسبة") {
      const err: any = new Error("Cannot edit a return that has already been confirmed and posted");
      err.statusCode = 409;
      throw err;
    }

    const returnDoc = await this.repository.update(id, dto);
    ERPCache.delete(LIST_CACHE_KEY);

    ERPEventBus.getInstance().emitEvent("SalesReturnUpdated", {
      returnId: id,
      timestamp: new Date()
    });

    return returnDoc;
  }

  async deleteReturn(id: number): Promise<void> {
    const found = await this.repository.getById(id);
    if (!found) {
      const err: any = new Error("Return not found");
      err.statusCode = 404;
      throw err;
    }

    if (found.status === "تم التأكيد والمحاسبة") {
      const err: any = new Error("Cannot delete a return that has already been confirmed and posted");
      err.statusCode = 409;
      throw err;
    }

    await this.repository.delete(id);
    ERPCache.delete(LIST_CACHE_KEY);

    ERPEventBus.getInstance().emitEvent("SalesReturnDeleted", {
      returnId: id,
      timestamp: new Date()
    });
  }
}
