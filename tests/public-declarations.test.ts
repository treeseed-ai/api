import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
class PublicDeclarationTests {
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
const suite=new PublicDeclarationTests();test('smoke: API declaration artifact references the public SDK container contract',suite.schema.bind(suite));
