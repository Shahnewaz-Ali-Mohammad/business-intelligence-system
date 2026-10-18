import { withDatabase } from './connectors.mjs';
import { procedureDefaults, procedureHash, reviewProcedure } from './report-procedures.mjs';

// Shared catalog reader: web and worker review exactly the same metadata.
export async function loadProcedureMetadata(config, routineId) {
  return withDatabase(config, async query => {
    const procedures = await query(`SELECT p.object_id AS id,s.name AS schema_name,p.name,${routineId ? 'm.definition' : 'NULL AS definition'} FROM sys.procedures p JOIN sys.schemas s ON s.schema_id=p.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=p.object_id WHERE p.is_ms_shipped=0 AND HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(p.name),'OBJECT','EXECUTE')=1${routineId ? ' AND p.object_id=@p1' : ''} ORDER BY s.name,p.name`, routineId ? [routineId] : []);
    if (!routineId) return procedures.map(p => ({ id: Number(p.id), schema: String(p.schema_name), name: String(p.name), definition: '', hash: '', allowed: false, reason: '', requiresWriteConsent: false, parameters: [] }));
    const parameters = await query(`SELECT p.name,t.name AS type,TYPE_NAME(p.system_type_id) AS base_type,p.is_output AS output,p.max_length,p.precision,p.scale,p.has_default_value,t.is_table_type,ts.name AS type_schema,tt.type_table_object_id FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id JOIN sys.schemas ts ON ts.schema_id=t.schema_id LEFT JOIN sys.table_types tt ON tt.user_type_id=p.user_type_id WHERE p.object_id=@p1 AND p.parameter_id>0 ORDER BY p.parameter_id`, [routineId]);
    const columns = await query(`SELECT tt.type_table_object_id,c.name,t.name AS type,TYPE_NAME(c.system_type_id) AS base_type,c.max_length,c.precision,c.scale,c.is_nullable FROM sys.parameters p JOIN sys.table_types tt ON tt.user_type_id=p.user_type_id JOIN sys.columns c ON c.object_id=tt.type_table_object_id JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE p.object_id=@p1 ORDER BY c.column_id`, [routineId]);
    const scalar = param => ({ name: String(param.name), type: String(param.type), baseType: String(param.base_type || param.type), output: Boolean(param.output), maxLength: Number(param.max_length), precision: Number(param.precision), scale: Number(param.scale), nullable: Boolean(param.is_nullable) });
    return procedures.map(p => {
      const definition = p.definition ? String(p.definition) : '';
      const defaults = procedureDefaults(definition, parameters);
      const parsed = parameters.map(param => ({ ...scalar(param), hasDefault: Boolean(param.has_default_value || defaults[String(param.name)]), ...(param.is_table_type ? { tableType: `[${String(param.type_schema).replace(/]/g, ']]')}].[${String(param.type).replace(/]/g, ']]')}]`, tableColumns: columns.filter(c => Number(c.type_table_object_id) === Number(param.type_table_object_id)).map(scalar) } : {}) }));
      return { id: Number(p.id), schema: String(p.schema_name), name: String(p.name), definition, hash: procedureHash(JSON.stringify({ definition, parameters: parsed })), ...reviewProcedure(definition), parameters: parsed };
    });
  });
}
