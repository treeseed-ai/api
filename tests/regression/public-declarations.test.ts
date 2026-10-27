import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
class PublicDeclarationTests {
 legacy():void{
  const file=ts.createSourceFile('container.d.ts',readFileSync('dist/src/container.d.ts','utf8'),ts.ScriptTarget.Latest,true);let definition:ts.TypeNode|undefined,declaration:ts.TypeNode|undefined;
  for(const statement of file.statements)if(ts.isClassDeclaration(statement)&&statement.name?.text==='NodeApiContainerPlugin')for(const member of statement.members)if(ts.isPropertyDeclaration(member)&&ts.isIdentifier(member.name)){if(member.name.text==='definition')definition=member.type;if(member.name.text==='declaration')declaration=member.type;}
  if(!definition||!ts.isTypeReferenceNode(definition)||!declaration||!ts.isTypeReferenceNode(declaration))throw new Error('PUBLIC_LEGACY_SCHEMA_DECLARATION_REQUIRED');
  expect(definition.typeName.getText(file)).toBe('ReturnType');expect(declaration.typeName.getText(file)).toBe('ProviderDeclaration');const query=definition.typeArguments?.[0];if(!query||!ts.isTypeQueryNode(query))throw new Error('PUBLIC_LEGACY_SCHEMA_DECLARATION_REQUIRED');expect(query.exprName.getText(file)).toBe('InstalledSchemas.definition.parse');
 }
 providers():void{
  const file=ts.createSourceFile('services.d.ts',readFileSync('dist/src/services.d.ts','utf8'),ts.ScriptTarget.Latest,true);
  for(const name of ['NodeApiServicePlugin','ApiReadinessPlugin']){let declaration:ts.TypeNode|undefined;for(const statement of file.statements)if(ts.isClassDeclaration(statement)&&statement.name?.text===name)for(const member of statement.members)if(ts.isPropertyDeclaration(member)&&ts.isIdentifier(member.name)&&member.name.text==='declaration')declaration=member.type;if(!declaration||!ts.isTypeReferenceNode(declaration))throw new Error('PUBLIC_PROVIDER_SCHEMA_DECLARATION_REQUIRED');const query=declaration.typeArguments?.[0];if(!query||!ts.isTypeQueryNode(query))throw new Error('PUBLIC_PROVIDER_SCHEMA_DECLARATION_REQUIRED');expect(query.exprName.getText(file)).toBe('ProviderV4Schemas.declaration.parse');}
 }
 schema():void{
  const file=ts.createSourceFile('services.d.ts',readFileSync('dist/src/services.d.ts','utf8'),ts.ScriptTarget.Latest,true);
  let type:ts.TypeNode|undefined;
  for(const statement of file.statements)if(ts.isClassDeclaration(statement)&&statement.name?.text==='NodeApiServicePlugin')for(const member of statement.members)if(ts.isPropertyDeclaration(member)&&ts.isIdentifier(member.name)&&member.name.text==='container')type=member.type;
  if(!type||!ts.isTypeReferenceNode(type))throw new Error('PUBLIC_SCHEMA_DECLARATION_REQUIRED');
  expect(type.typeName.getText(file)).toBe('ReturnType');expect(type.typeArguments?.length).toBe(1);
  const query=type.typeArguments![0]!;if(!ts.isTypeQueryNode(query))throw new Error('PUBLIC_SCHEMA_DECLARATION_REQUIRED');
  expect(query.exprName.getText(file)).toBe('ServiceProjectionSchemas.container.parse');
 }
}
const suite=new PublicDeclarationTests();test("regression: API declaration artifact references the public SDK container contract",suite.schema.bind(suite));
test("regression: retained API metadata names the historical SDK contracts",suite.legacy.bind(suite));
test("regression: native API metadata names the current SDK provider contract",suite.providers.bind(suite));
