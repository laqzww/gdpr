#!/usr/bin/env node

// Test the corrected filter logic

function shouldIncludeInIndex(status) {
    // Only include hearings with status "Afventer konklusion" in the search index
    return status && status.toLowerCase().includes('afventer konklusion');
}

const testCases = [
    { id: 107, title: "Nordre Fasanvej Nord - forslag til lokalplan", status: "Afventer konklusion" },
    { id: 167, title: "Svanemølleholm Øst - forslag til lokalplan og miljørapport", status: "Afventer konklusion" },
    { id: 168, title: "Tillæg 6 til lp Grønttorvsområdet - forslag til lokalplan", status: "Afventer konklusion" },
    { id: 190, title: "Klimastrategi og Klimahandleplan", status: "Afventer konklusion" },
    { id: 192, title: "Sundmolen Øst - forslag til lokalplan", status: "Aktiv" },
    { id: 999, title: "Test høring", status: "I høring" },
    { id: 998, title: "Anden test", status: "Konkluderet" }
];

console.log('=== Test af rettet filter logik ===\n');
console.log('Kun høringer med status "Afventer konklusion" skal inkluderes i søgeindekset:\n');

for (const hearing of testCases) {
    const included = shouldIncludeInIndex(hearing.status);
    const symbol = included ? '✅' : '❌';
    console.log(`${symbol} Høring ${hearing.id}: "${hearing.title}" [${hearing.status}]`);
}

console.log('\nForventet resultat:');
console.log('- Høring 107, 167, 168, 190: ✅ (Afventer konklusion)');
console.log('- Høring 192, 999, 998: ❌ (Andre statusser)');

// Count included
const includedCount = testCases.filter(h => shouldIncludeInIndex(h.status)).length;
const excludedCount = testCases.length - includedCount;

console.log(`\nTotal: ${includedCount} inkluderet, ${excludedCount} ekskluderet`);