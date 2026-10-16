import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAuthoritativeQboReportBasis,
  QboReportBasisError,
} from "../src/services/bookkeeping/qboReportBasis.js";

test("extracts the documented direct QBO report basis from Header and ReportHeader", () => {
  assert.equal(extractAuthoritativeQboReportBasis({ Header: { ReportBasis: "Cash" } }), "Cash");
  assert.equal(extractAuthoritativeQboReportBasis({ ReportHeader: { ReportBasis: "Accrual" } }), "Accrual");
});

test("retains recognized Option and Options basis entries as compatibility fallbacks", () => {
  assert.equal(extractAuthoritativeQboReportBasis({ Header: { Option: [{ Name: "ReportBasis", Value: "Cash" }] } }), "Cash");
  assert.equal(extractAuthoritativeQboReportBasis({ Header: { Options: [{ name: "report_basis", value: "cash" }] } }), "Cash");
  assert.equal(extractAuthoritativeQboReportBasis({ Header: { Options: { Name: "ReportBasis", Value: "Cash" } } }), "Cash");
});

test("rejects missing, malformed, unsupported, and conflicting provider basis metadata", () => {
  const cases = [
    [{ Header: { Option: [{ Name: "AccountingStandard", Value: "GAAP" }] } }, "qbo_report_basis_unproven"],
    [{ Header: { ReportBasis: "" } }, "qbo_report_basis_malformed"],
    [{ Header: { ReportBasis: "ModifiedCash" } }, "qbo_report_basis_unsupported"],
    [{ Header: { ReportBasis: "Cash", Option: [{ Name: "ReportBasis", Value: "Accrual" }] } }, "qbo_report_basis_conflicting"],
    [{ Header: { ReportBasis: "Cash" }, ReportHeader: { ReportBasis: "Accrual" } }, "qbo_report_basis_conflicting"],
  ];
  for (const [report, code] of cases) {
    assert.throws(
      () => extractAuthoritativeQboReportBasis(report),
      (error) => error instanceof QboReportBasisError && error.code === code,
    );
  }
});
