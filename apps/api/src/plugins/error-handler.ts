import { Elysia } from 'elysia';
import { AppError } from '../errors';
import { conflictingField, isForeignKeyViolation, isUniqueViolation } from '../utils/Errors.util';
import type { ApiError } from '@pottery/shared';


export const errorHandler = new Elysia({name: 'error-handler'})
.onError({as: 'global'} , ({code, error , set}) => {
    if(error instanceof AppError){
        set.status = error.status
        return {
            code: error.code,
            message: error.message,
            ...(error.field !== undefined ? {field: error.field} : {})
        } satisfies ApiError;
    }
    if(code === 'VALIDATION' && error.type !== 'response'){
    
            set.status = 422;
            return {
                code: 'VALIDATION_FAILED',
                message: 'the validation failed',
                issues: error.all.map((issue) => ({
                    path: issue.path , message: issue.message
                }))
            } satisfies ApiError;
    }
    if( code === 'NOT_FOUND'){
        set.status = 404;
        return {
            code : 'NOT_FOUND',
            message: 'ROUTE NOT FOUND',
        } satisfies ApiError; 
    }
    if( code === 'PARSE') {
        set.status = 400; 
        return {
            code: 'BAD_REQUEST',
            message: 'The request body could not be read . send valid JSON',
        } satisfies ApiError;
    }
    if(isUniqueViolation(error)){
        set.status = 409;
        return {
            code : 'CONFLICT',
            message: 'That Value is Already in use',
            field: conflictingField(error),
        } satisfies ApiError;
    }
    if(isForeignKeyViolation(error)){
        set.status = 409;
        return {
            code: 'CONFLICT',
            message: 'This change conflicts with related records.',
        } satisfies ApiError;
    }

    console.error(error)
    set.status = 500;
    return {code: 'INTERNAL' , message: 'Something Went Wrong'} satisfies ApiError;
})