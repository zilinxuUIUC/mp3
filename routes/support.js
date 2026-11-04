const mongoose = require('mongoose');

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function fail(status, message) {
    throw new HttpError(status, message);
}

function validId(id) {
    return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
}

async function resource(Model, id, session) {
    if (!validId(id)) fail(404, `${Model.modelName} not found.`);
    const document = await Model.findById(id).session(session || null);
    if (!document) fail(404, `${Model.modelName} not found.`);
    return document;
}

function bodyObject(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail(400, 'The request body must be an object.');
    }
    return body;
}

function requiredString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        fail(400, `${field} must be a nonempty string.`);
    }
    return value;
}

function userFields(body) {
    bodyObject(body);
    const name = requiredString(body.name, 'Name');
    const email = requiredString(body.email, 'Email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Email must be a valid email address.');
    const pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;
    if (!Array.isArray(pendingTasks) || !pendingTasks.every(validId)) {
        fail(400, 'Pending tasks must be a list of valid task IDs.');
    }
    return { name, email, pendingTasks: [...new Set(pendingTasks.map(id => id.toLowerCase()))] };
}

function taskFields(body) {
    bodyObject(body);
    const name = requiredString(body.name, 'Name');
    if (!['string', 'number'].includes(typeof body.deadline) ||
        (typeof body.deadline === 'string' && !body.deadline.trim()) ||
        !Number.isFinite(new Date(body.deadline).getTime())) {
        fail(400, 'Deadline must be a valid date.');
    }
    const description = body.description === undefined ? '' : body.description;
    const completed = body.completed === undefined ? false : body.completed;
    const assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
    if (typeof description !== 'string') fail(400, 'Description must be a string.');
    if (typeof completed !== 'boolean') fail(400, 'Completed must be true or false.');
    if (assignedUser !== '' && !validId(assignedUser)) fail(400, 'Assigned user must be a valid user ID or an empty string.');
    if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string') {
        fail(400, 'Assigned user name must be a string.');
    }
    return {
        name, description, deadline: new Date(body.deadline), completed,
        assignedUser: assignedUser.toLowerCase(),
        assignedUserName: body.assignedUserName === undefined ? 'unassigned' : body.assignedUserName
    };
}

function jsonParameter(query, name, fallback) {
    if (query[name] === undefined) return fallback;
    if (typeof query[name] !== 'string') fail(400, `${name} must be a single JSON value.`);
    try {
        return JSON.parse(query[name]);
    } catch {
        fail(400, `${name} must contain valid JSON.`);
    }
}

function objectParameter(query, name) {
    const value = jsonParameter(query, name, {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, `${name} must be a JSON object.`);
    return value;
}

function projection(query) {
    const select = objectParameter(query, 'select');
    if (!Object.values(select).every(value => value === 0 || value === 1)) {
        fail(400, 'Select fields must be 0 or 1.');
    }
    const modes = new Set(Object.entries(select).filter(([key]) => key !== '_id').map(([, value]) => value));
    if (modes.size > 1) fail(400, 'Select cannot mix included and excluded fields, except for _id.');
    return select;
}

function collectionParameters(query, defaultLimit) {
    const where = objectParameter(query, 'where');
    const sort = objectParameter(query, 'sort');
    const select = projection(query);
    const skip = jsonParameter(query, 'skip', 0);
    const limit = jsonParameter(query, 'limit', defaultLimit);
    const count = jsonParameter(query, 'count', false);
    if (!Object.values(sort).every(value => value === 1 || value === -1)) fail(400, 'Sort fields must be 1 or -1.');
    if (!Number.isSafeInteger(skip) || skip < 0) fail(400, 'Skip must be a nonnegative integer.');
    if (!Number.isSafeInteger(limit) || limit < 0) fail(400, 'Limit must be a nonnegative integer.');
    if (typeof count !== 'boolean') fail(400, 'Count must be true or false.');
    return { where, sort, select, skip, limit, count };
}

async function queryResult(operation) {
    try {
        return await operation();
    } catch (error) {
        if (error.name === 'CastError' || error.name === 'StrictModeError' ||
            (error.name === 'MongoServerError' && [2, 9, 14, 72, 159, 168, 16872, 31253, 31254].includes(error.code)) ||
            /^(Can't use|Invalid (sort|projection)|Invalid UTF-8)/.test(error.message)) {
            fail(400, 'The query contains an invalid field value or operator.');
        }
        throw error;
    }
}

function readRoutes(router, path, Model, defaultLimit) {
    router.get(path, async (req, res) => {
        const params = collectionParameters(req.query, defaultLimit);
        const data = await queryResult(() => params.count
            ? Model.countDocuments(params.where).exec()
            : Model.find(params.where).sort(params.sort).select(params.select).skip(params.skip).limit(params.limit).lean().exec());
        res.json({ message: 'OK', data });
    });
    router.get(`${path}/:id`, async (req, res) => {
        if (!validId(req.params.id)) fail(404, `${Model.modelName} not found.`);
        const select = projection(req.query);
        const data = await queryResult(() => Model.findById(req.params.id).select(select).lean().exec());
        if (!data) fail(404, `${Model.modelName} not found.`);
        res.json({ message: 'OK', data });
    });
}

function errorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    let status = error instanceof HttpError ? error.status : 500;
    let message = error instanceof HttpError ? error.message : 'Unable to complete the request. Please try again later.';
    if (error.code === 11000) {
        status = 400;
        message = 'That email address is already in use.';
    } else if (error.type === 'entity.parse.failed') {
        status = 400;
        message = 'The request body must contain valid JSON.';
    } else if (error.name === 'ValidationError') {
        status = 400;
        message = 'One or more fields contain invalid values.';
    } else if (error.type === 'entity.too.large') {
        status = 400;
        message = 'The request body is too large.';
    }
    if (status === 500) console.error('Request failed:', error.name);
    res.status(status).json({ message, data: null });
}

module.exports = { fail, resource, userFields, taskFields, readRoutes, errorHandler };
