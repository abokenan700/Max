import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const mockProducts = [
  {
    id: 1,
    name: "عطر شانيل No.5",
    brand: "CHANEL",
    price: 385,
    original_price: 550,
    discount: 30,
    image: "https://images.unsplash.com/photo-1541643600914-78b084683702?w=400",
    is_new: false,
    rating: 4.9,
    sales: 1420,
    colors: ["#F5F0E8", "#E8D5B7", "#C0A882"],
  },
  {
    id: 2,
    name: "حقيبة ديور سادل",
    brand: "DIOR",
    price: 890,
    original_price: 1200,
    discount: 25,
    image: "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=400",
    is_new: false,
    rating: 4.8,
    sales: 856,
    colors: ["#2C1810", "#8B6F47", "#D4AF37"],
  },
  {
    id: 3,
    name: "خاتم ذهب عيار 18",
    brand: "CARTIER",
    price: 1200,
    original_price: 1500,
    discount: 20,
    image: "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=400",
    is_new: true,
    rating: 5,
    sales: 234,
    colors: ["#FFD700", "#C0C0C0", "#FF69B4"],
  },
  {
    id: 4,
    name: "ساعة رولكس",
    brand: "ROLEX",
    price: 5000,
    original_price: 6200,
    discount: 19,
    image: "https://images.unsplash.com/photo-1523293182086-7651a899d37f?w=400",
    is_new: false,
    rating: 4.9,
    sales: 189,
    colors: ["#FFD700", "#C0C0C0", "#2C2C2C"],
  },
  {
    id: 5,
    name: "نظارة ريبان",
    brand: "RAY-BAN",
    price: 150,
    original_price: 200,
    discount: 25,
    image: "https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=400",
    is_new: false,
    rating: 4.7,
    sales: 2100,
    colors: ["#2C2C2C", "#8B6914", "#4B0082"],
  },
  {
    id: 6,
    name: "عطر برادا",
    brand: "PRADA",
    price: 280,
    original_price: 420,
    discount: 33,
    image: "https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=400",
    is_new: true,
    rating: 4.8,
    sales: 567,
    colors: ["#E8D5B7", "#2C1810", "#8B7355"],
  },
];

/* ── GET /products ─────────────────────────────────────────────────────── */
router.get("/products", (req: Request, res: Response) => {
  const { page = 1, limit = 12, brand, sort } = req.query;
  const pageNum = Math.max(1, parseInt(page as string) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 12));

  let filtered = mockProducts;

  if (brand) {
    const brands = (typeof brand === "string" ? [brand] : brand).map(b => (b as string).toUpperCase());
    filtered = filtered.filter(p => brands.includes(p.brand));
  }

  if (sort === "price_asc") {
    filtered.sort((a, b) => a.price - b.price);
  } else if (sort === "price_desc") {
    filtered.sort((a, b) => b.price - a.price);
  } else if (sort === "rating") {
    filtered.sort((a, b) => b.rating - a.rating);
  } else if (sort === "sales") {
    filtered.sort((a, b) => b.sales - a.sales);
  }

  const total = filtered.length;
  const totalPages = Math.ceil(total / limitNum);
  const start = (pageNum - 1) * limitNum;
  const items = filtered.slice(start, start + limitNum);

  res.json({
    items,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
    },
  });
});

/* ── GET /products/:id ─────────────────────────────────────────────────── */
router.get("/products/:id", (req: Request, res: Response) => {
  const product = mockProducts.find(p => p.id === parseInt(req.params.id));

  if (!product) {
    res.status(404).json({ error: "المنتج غير موجود" });
    return;
  }

  res.json({
    ...product,
    description: `وصف تفصيلي لـ ${product.name}`,
    details: {
      material: "مادة عالية الجودة",
      warranty: "ضمان سنتان",
      origin: "مستورد أصلي",
    },
  });
});

/* ── GET /products/search ──────────────────────────────────────────────── */
router.get("/products/search", (req: Request, res: Response) => {
  const { q } = req.query;
  const query = (q as string || "").toLowerCase();

  if (!query) {
    res.status(400).json({ error: "يرجى إدخال كلمة بحث" });
    return;
  }

  const results = mockProducts.filter(p =>
    p.name.toLowerCase().includes(query) ||
    p.brand.toLowerCase().includes(query)
  );

  res.json({ results, count: results.length });
});

export default router;
