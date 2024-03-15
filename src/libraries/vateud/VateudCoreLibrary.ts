import axios, { Method } from "axios";
import JobLibrary, { JobTypeEnum } from "../JobLibrary";
import {
    VateudCoreSoloCreateResponseT,
    VateudCoreSoloCreateT,
    VateudCoreSoloRemoveResponseT,
    VateudCoreSoloRemoveT,
    VateudCoreTypeEnum,
} from "./VateudCoreLibraryTypes";
import { Config } from "../../core/Config";
import { UserSolo } from "../../models/UserSolo";
import Logger, { LogLevels } from "../../utility/Logger";

type SendT = {
    method: Method;
    endpoint: string;
    data?: any;
};

/**
 * Sends the actual request to VATEUD Core
 * @param props
 */
async function _send<T>(props: SendT): Promise<T | undefined> {
    if (Config.VATEUD_CORE_CONFIG.API_KEY == null) {
        Logger.log(LogLevels.LOG_ERROR, `VATEUD Core API Key missing, but attempted to update: ${props.endpoint}. Aborting.`);
        return undefined;
    }

    try {
        const res = await axios({
            headers: {
                "x-api-key": Config.VATEUD_CORE_CONFIG.API_KEY,
            },
            url: `${Config.URI_CONFIG.VATEUD_API_BASE}/${props.endpoint}`,
            method: props.method,
            data: props.data,
        });

        return res.data as T;
    } catch (e) {
        return undefined;
    }
}

/**
 * Creates a solo.
 * On success, it updates the corresponding UserSolo with the returned VATEUD Solo ID
 * On failure, it schedules a job which repeats the same request n times until it succeeds
 * - If it fails more than n times, then it really isn't our problem anymore tbh...
 * @param soloInfo
 */
async function createSolo(soloInfo: VateudCoreSoloCreateT) {
    const res = await _send<VateudCoreSoloCreateResponseT>({
        endpoint: "/solo",
        method: "post",
        data: soloInfo.post_data,
    });
    if (!res) {
        // If the request fails, we schedule a job to attempt it additional times.
        await JobLibrary.scheduleJob(JobTypeEnum.VATEUD_CORE, {
            type: VateudCoreTypeEnum.SOLO_CREATE,
            method: "post",
            data: {
                solo_create: {
                    local_solo_id: soloInfo.local_solo_id,
                    user_id: soloInfo.post_data.user_id,
                    position: soloInfo.post_data.position,
                    instructor_cid: soloInfo.post_data.instructor_cid,
                    expire_at: soloInfo.post_data.expires_at,
                },
            },
        });
        return undefined;
    }

    await UserSolo.update(
        {
            vateud_solo_id: res.data.id,
        },
        {
            where: {
                id: soloInfo.local_solo_id,
            },
        }
    );

    return res;
}

/**
 * Removes a solo.
 * On failure, it schedules a job which repeats the same request n times until it succeeds
 * @param soloInfo
 */
async function removeSolo(soloInfo: VateudCoreSoloRemoveT) {
    const res = await _send<VateudCoreSoloRemoveResponseT>({
        endpoint: `/solo/${soloInfo.vateud_solo_id}`,
        method: "delete",
    });
    if (!res) {
        await JobLibrary.scheduleJob(JobTypeEnum.VATEUD_CORE, {
            type: VateudCoreTypeEnum.SOLO_REMOVE,
            method: "delete",
            data: {
                solo_remove: {
                    local_solo_id: soloInfo.local_solo_id,
                    vateud_solo_id: soloInfo.vateud_solo_id,
                },
            },
        });
    }
}

export default {
    createSolo,
    removeSolo,
};
