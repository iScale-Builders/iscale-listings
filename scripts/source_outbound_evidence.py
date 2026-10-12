"""
Shared no-secret Gmail evidence queries for outbound source-access requests.

These strings are printed for a human operator. They do not connect to Gmail,
read messages, create drafts, send mail, or include secrets.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OutboundEvidence:
    sent_query: str
    draft_query: str
    note: str


OUTBOUND_EVIDENCE = {
    "EUIPO": OutboundEvidence(
        sent_query=(
            'in:sent to:(docs.apiplatform@euipo.europa.eu OR apiplatform@euipo.europa.eu) '
            '(subject:("Documentation for iScale Listings API subscription request") '
            'OR "iScale Listings" OR "Trademark Search") -in:trash'
        ),
        draft_query=(
            'in:drafts to:(docs.apiplatform@euipo.europa.eu OR apiplatform@euipo.europa.eu) '
            '(subject:("Documentation for iScale Listings API subscription request") '
            'OR "iScale Listings" OR "Trademark Search") -in:trash'
        ),
        note="Confirm the documentation email is actually sent, not only drafted.",
    ),
    "DE": OutboundEvidence(
        sent_query='in:sent to:(datenabgabe@dpma.de OR dpma.de) (DPMAconnectPlus OR Marken OR trademark) -in:trash',
        draft_query='in:drafts to:(datenabgabe@dpma.de OR dpma.de) (DPMAconnectPlus OR Marken OR trademark) -in:trash',
        note="Confirm the DPMA source-access request left drafts.",
    ),
    "IT": OutboundEvidence(
        sent_query=(
            'in:sent to:(richiestacopie.uibm@mise.gov.it OR uibm.gov.it OR mise.gov.it) '
            '("Marchi di impresa" OR UIBM OR extract OR estratto) -in:trash'
        ),
        draft_query=(
            'in:drafts to:(richiestacopie.uibm@mise.gov.it OR uibm.gov.it OR mise.gov.it) '
            '("Marchi di impresa" OR UIBM OR extract OR estratto) -in:trash'
        ),
        note="Confirm the UIBM extract request left drafts.",
    ),
    "ES": OutboundEvidence(
        sent_query='in:sent to:(opendata@oepm.es OR oepm.es) (OEPM OR OpenData OR MARCAS OR ST.66) -in:trash',
        draft_query='in:drafts to:(opendata@oepm.es OR oepm.es) (OEPM OR OpenData OR MARCAS OR ST.66) -in:trash',
        note="Confirm the OEPM OpenData request left drafts.",
    ),
    "UK": OutboundEvidence(
        sent_query='in:sent to:(information@ipo.gov.uk OR ipo.gov.uk) ("trade mark register" OR "trademark register" OR data) -in:trash',
        draft_query='in:drafts to:(information@ipo.gov.uk OR ipo.gov.uk) ("trade mark register" OR "trademark register" OR data) -in:trash',
        note="Confirm the UK IPO current-register request left drafts.",
    ),
    "JP": OutboundEvidence(
        sent_query='in:sent to:(PA0630@jpo.go.jp OR jpo.go.jp OR inpit.go.jp) ("Download Service" OR "standardized data" OR trademark) -in:trash',
        draft_query='in:drafts to:(PA0630@jpo.go.jp OR jpo.go.jp OR inpit.go.jp) ("Download Service" OR "standardized data" OR trademark) -in:trash',
        note="Confirm the JPO/INPIT source-access request left drafts.",
    ),
}


def outbound_evidence_for(jurisdiction: str) -> OutboundEvidence | None:
    return OUTBOUND_EVIDENCE.get(jurisdiction)
