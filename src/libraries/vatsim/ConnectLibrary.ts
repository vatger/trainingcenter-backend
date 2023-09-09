import axios, { Axios, AxiosResponse, HttpStatusCode } from "axios";
import { Request, Response } from "express";
import { VatsimOauthToken, VatsimScopes, VatsimUserData } from "./ConnectTypes";
import { ConnectLibraryErrors, VatsimConnectException } from "../../exceptions/VatsimConnectException";
import { checkIsUserBanned } from "../../utility/helper/MembershipHelper";
import { UserSession } from "../../models/UserSession";
import { createSessionToken } from "../session/SessionLibrary";
import { UserData } from "../../models/UserData";
import { User } from "../../models/User";
import { Role } from "../../models/Role";
import { UserSettings } from "../../models/UserSettings";
import { Config } from "../../core/Config";
import { sequelize } from "../../core/Sequelize";
import { ValidatorType } from "../../controllers/_validators/ValidatorType";
import ValidationHelper, { ValidationOptions } from "../../utility/helper/ValidationHelper";

export type ConnectOptions = {
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    base_uri?: string;
    client_scopes: string;
};

export class VatsimConnectLibrary {
    private readonly m_axiosInstance: Axios;

    private readonly m_connectOptions: ConnectOptions | undefined = undefined;
    private readonly m_remember: boolean;

    private m_accessToken: string | undefined = undefined;
    private m_refreshToken: string | undefined = undefined;
    private m_suppliedScopes: VatsimScopes | undefined = undefined;

    private m_userData: VatsimUserData | undefined = undefined;
    private m_response: Response | undefined = undefined;
    private m_request: Request | undefined = undefined;

    constructor(connectOptions?: ConnectOptions, remember?: boolean) {
        this.m_connectOptions = connectOptions;
        this.m_remember = remember ?? false;

        if (connectOptions == null) throw new VatsimConnectException();

        this.m_axiosInstance = axios.create({
            baseURL: this.m_connectOptions?.base_uri ?? Config.CONNECT_CONFIG.BASE_URL,
            timeout: 5000,
            headers: { "Accept-Encoding": "gzip,deflate,compress" },
        });
    }

    /**
     * Handle the login flow
     * @throws VatsimConnectException
     */
    public async login(request: Request, response: Response, code: string | undefined) {
        if (code == null) throw new VatsimConnectException(ConnectLibraryErrors.ERR_NO_CODE);

        this.m_response = response;
        this.m_request = request;

        await this._queryAccessTokens(code);
        await this._queryUserData();

        if (this.m_userData == null) {
            response.sendStatus(HttpStatusCode.InternalServerError);
            return;
        }

        this._validateSuppliedScopes();
        await this._checkIsUserSuspended();

        if (this.m_userData == null) throw new VatsimConnectException();

        // Create database entries
        await this._updateDatabase();

        await UserSettings.findOrCreate({
            where: {
                user_id: this.m_userData.data.cid,
            },
            defaults: {
                user_id: this.m_userData.data.cid,
                language: "de",
                additional_emails: [],
                email_notifications_enabled: true,
            },
        });

        const user: User | null = await User.scope("sensitive").findOne({
            where: {
                id: this.m_userData?.data.cid,
            },
            include: [
                {
                    association: User.associations.user_data,
                    as: "user_data",
                },
                {
                    association: User.associations.user_settings,
                    as: "user_settings",
                },
                {
                    association: User.associations.roles,
                    as: "roles",
                    attributes: ["name"],
                    through: { attributes: [] },

                    include: [
                        {
                            association: Role.associations.permissions,
                            attributes: ["name"],
                            through: { attributes: [] },
                        },
                    ],
                },
            ],
        });

        const session = await this._handleSessionChange();
        if (session) {
            response.send(user);
            return;
        }

        throw new VatsimConnectException(ConnectLibraryErrors.ERR_UNABLE_CREATE_SESSION);
    }

    /**
     * Updates the user data of the requesting user
     * Queries the VATSIM API (if the access token is valid)
     * If not, don't bother refreshing, send the user to the login page - it's easier ;)
     * @param request
     * @param response
     */
    public async updateUserData(request: Request, response: Response) {
        const user: User = request.body.user;

        const userWithAccessToken = await User.scope("internal").findOne({
            where: {
                id: user.id,
            },
        });

        if (userWithAccessToken == null) {
            response.sendStatus(HttpStatusCode.InternalServerError);
            return;
        }

        this.m_accessToken = userWithAccessToken.access_token ?? undefined;
        this.m_refreshToken = userWithAccessToken.refresh_token ?? undefined;

        const newUserData = await this._queryUserData();
        if (newUserData == null) {
            response.sendStatus(HttpStatusCode.InternalServerError);
            return;
        }

        // Create database entries
        await this._updateDatabase();

        const newUser = await User.scope("sensitive").findOne({
            where: {
                id: this.m_userData?.data.cid,
            },
            include: [
                {
                    association: User.associations.user_data,
                    as: "user_data",
                },
                {
                    association: User.associations.user_settings,
                    as: "user_settings",
                },
                {
                    association: User.associations.roles,
                    as: "roles",
                    attributes: ["name"],
                    through: { attributes: [] },

                    include: [
                        {
                            association: Role.associations.permissions,
                            attributes: ["name"],
                            through: { attributes: [] },
                        },
                    ],
                },
            ],
        });

        if (newUser == null) {
            response.sendStatus(HttpStatusCode.InternalServerError);
            return;
        }

        response.send(newUser);
    }

    /**
     * Query the VATSIM oauth/token endpoint to receive the access and refresh tokens
     * @param vatsim_code
     * @private
     */
    private async _queryAccessTokens(vatsim_code: string) {
        // Query access token
        let auth_response: AxiosResponse = {} as AxiosResponse;

        try {
            auth_response = await this.m_axiosInstance.post("/oauth/token", {
                code: vatsim_code,
                grant_type: "authorization_code",
                client_id: this.m_connectOptions?.client_id,
                client_secret: this.m_connectOptions?.client_secret,
                redirect_uri: this.m_connectOptions?.redirect_uri,
            });
        } catch (e: any) {
            console.log(e);
            if (e.response.data.hint.toLowerCase().includes("revoked")) {
                throw new VatsimConnectException(ConnectLibraryErrors.ERR_INV_CODE);
            }
        }

        const auth_response_data: VatsimOauthToken | undefined = auth_response.data as VatsimOauthToken;

        if (auth_response_data == null) {
            throw new VatsimConnectException(ConnectLibraryErrors.ERR_INV_SCOPES);
        }

        this.m_accessToken = auth_response_data.access_token;
        this.m_refreshToken = auth_response_data.refresh_token;
        this.m_suppliedScopes = auth_response_data.scopes as VatsimScopes;
    }

    /**
     * Query the VATSIM api/user endpoint to receive the actual user data
     * @private
     */
    private async _queryUserData() {
        if (this.m_accessToken == null) return null;

        let user_response: AxiosResponse | undefined = undefined;

        try {
            user_response = await this.m_axiosInstance.get("/api/user", {
                headers: {
                    Authorization: `Bearer ${this.m_accessToken}`,
                    Accept: "application/json",
                },
            });
        } catch (e) {}

        const user_response_data: VatsimUserData | undefined = user_response?.data as VatsimUserData;

        this.m_userData = user_response_data;
        return user_response_data;
    }

    /**
     * Validates whether the supplied scopes are sufficient
     * @private
     * @throws VatsimConnectException - If the supplied scopes are not valid, throws an exception
     */
    private _validateSuppliedScopes() {
        if (this.m_suppliedScopes == null) throw new VatsimConnectException();

        const required_scopes = this.m_connectOptions?.client_scopes.split(" ") as VatsimScopes;
        for (let i = 0; i < required_scopes.length; i++) {
            if (this.m_suppliedScopes.indexOf(required_scopes[i]) === -1) {
                throw new VatsimConnectException(ConnectLibraryErrors.ERR_INV_SCOPES);
            }
        }
    }

    /**
     * Checks if the given user trying to log in has been suspended from the system
     * @private
     * @throws VatsimConnectException - If the user is suspended, throws exception
     */
    private async _checkIsUserSuspended() {
        if (this.m_userData == undefined) return null;

        const suspension_status = await checkIsUserBanned(this.m_userData.data.cid);
        if (suspension_status || this.m_userData.data.vatsim.rating.id === 0) {
            throw new VatsimConnectException(ConnectLibraryErrors.ERR_SUSPENDED);
        }
    }

    private async _handleSessionChange() {
        const browserUUID: string | string[] | undefined = this.m_request?.headers["unique-browser-token"];

        if (this.m_response == null || this.m_request == null || browserUUID == null || this.m_userData?.data.cid == null) throw new VatsimConnectException();

        // Remove old session
        await UserSession.destroy({
            where: {
                user_id: this.m_userData.data.cid,
                browser_uuid: browserUUID,
            },
        });

        // Create new session
        return await createSessionToken(this.m_request, this.m_response, this.m_userData?.data.cid, this.m_remember);
    }

    /**
     * Check the validity of the user data returned by VATSIM
     * Returns true, if the structure is valid
     * @private
     */
    private _validateUserData(): ValidatorType {
        return ValidationHelper.validate([
            {
                name: "cid",
                validationObject: this.m_userData?.data.cid,
                toValidate: [{ val: ValidationOptions.NON_NULL }, { val: ValidationOptions.NUMBER }],
            },
            {
                name: "personal",
                validationObject: this.m_userData?.data.personal,
                toValidate: [{ val: ValidationOptions.NON_NULL }],
            },
            {
                name: "vatsim",
                validationObject: this.m_userData?.data.vatsim,
                toValidate: [{ val: ValidationOptions.NON_NULL }],
            },
        ]);
    }

    private async _updateDatabase() {
        if (this.m_userData == null || this._validateUserData().invalid) throw new VatsimConnectException();

        const tokenValid = this.m_userData.data.oauth.token_valid?.toLowerCase() === "true";
        const t = await sequelize.transaction();

        try {
            // Create database entries
            await User.upsert(
                {
                    id: this.m_userData.data.cid,
                    first_name: this.m_userData.data.personal.name_first,
                    last_name: this.m_userData.data.personal.name_last,
                    email: this.m_userData.data.personal.email,
                    access_token: tokenValid ? this.m_accessToken : null,
                    refresh_token: tokenValid ? this.m_refreshToken : null,
                },
                {
                    transaction: t,
                }
            );

            await UserData.upsert(
                {
                    user_id: this.m_userData.data.cid,
                    rating_atc: this.m_userData.data.vatsim.rating.id,
                    rating_pilot: this.m_userData.data.vatsim.pilotrating.id,
                    country_code: this.m_userData.data.personal.country.id,
                    country_name: this.m_userData.data.personal.country.name,
                    region_name: this.m_userData.data.vatsim.region.name,
                    region_code: this.m_userData.data.vatsim.region.id,
                    division_name: this.m_userData.data.vatsim.division.name,
                    division_code: this.m_userData.data.vatsim.division.id,
                    subdivision_name: this.m_userData.data.vatsim.subdivision.name,
                    subdivision_code: this.m_userData.data.vatsim.subdivision.id,
                },
                {
                    transaction: t,
                }
            );

            await t.commit();
        } catch (e) {
            await t.rollback();
        }
    }
}
