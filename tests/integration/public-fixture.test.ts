import{test,expect}from'bun:test';
class PublicFixtureTests{
 async contract():Promise<void>{const exported=await import('@treeseed-cordis/api/testing');expect(typeof exported.InstalledApiFixture).toBe('function');}
}
const suite=new PublicFixtureTests();
test('integration: API advertises its owner-only exact-archive fixture through a public export',suite.contract.bind(suite));
