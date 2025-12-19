// src/server/heroInsights/router.js
import { Router } from "express";
import { financialsHeroHandler } from "./financials.js";
import { marketingHeroHandler } from "./marketing.js";
import { taxHeroHandler } from "./tax.js";
import { investmentsHeroHandler } from "./investments.js";

const router = Router();

router.get("/:module", async (req, res) => {
  const { module } = req.params;

  switch ((module || "").toLowerCase()) {
    case "financials":
      return financialsHeroHandler(req, res);
    case "marketing":
      return marketingHeroHandler(req, res);
    case "tax":
      return taxHeroHandler(req, res);
    case "investments":
      return investmentsHeroHandler(req, res);
    default:
      return res.status(404).json({ hero: null, suppressIds: [] });
  }
});

export default router;
