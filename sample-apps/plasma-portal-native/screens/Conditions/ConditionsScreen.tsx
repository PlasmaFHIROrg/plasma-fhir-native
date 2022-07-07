import React, { useContext } from "react";
import { ScrollView, View, Text, StyleSheet } from "react-native";
import { Card } from "@rneui/base";
import Client from 'fhirclient/lib/Client';
import { PlasmaFHIRApi, Resources } from "plasma-fhir-app-utils";
import { FHIRClientContext } from "../../components/plasma-fhir-react-native-client-context";
import useDataLoadScreen from "./../../hooks/useDataLoadScreen";
import { FHIRr4 } from "./../../components/plasma-portal-components";

// TODO: For DSTU2, we don't want to pass in "problem-list-item". Don't pass in anything.

export default function ConditionsScreen() {
    const context = useContext(FHIRClientContext);
    const { 
        data: conditions, isDataLoaded, hasErrorLoading, errorMessage,
        elLoadingSpinner, elErrorMessage
    } = useDataLoadScreen<Resources.Condition>({
        patientId: context?.client?.patient.id || "",
        getData: (patientId: string) => (PlasmaFHIRApi.fromFHIRClient(context.client as any)).readCondition(patientId, { "category": "problem-list-item" })
    });

    return (
        <ScrollView style={styles.container}>
            <Text style={styles.header}>Conditions</Text>

            {/* Error Message */}
            {elErrorMessage}

            {/* Loading Spinner */}
            {elLoadingSpinner}

            {/* Conditions */}
            {isDataLoaded && !hasErrorLoading ? 
            <View>
            {
                conditions.map((condition: Resources.Condition, idx: number) => { 
                    return (
                        <Card key={"ConditionView_" + idx.toString()}>
                            <View>
                                <FHIRr4.ConditionView condition={condition} />
                            </View>
                        </Card>
                    );
                })
            }
            </View> : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { padding: 5 },
    
    header: { 
        fontSize: 36, 
        fontWeight: "bold", 
        paddingVertical: 4, 
        textAlign: "left"
    },
});